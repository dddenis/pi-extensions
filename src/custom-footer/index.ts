import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { makeEffectRunner } from "../lib/effect-runtime";
import { EnvironmentService } from "../services/environment";
import { FileSystemService } from "../services/file-system";
import { HomeDirectoryService } from "../services/home-directory";
import { ProcessService } from "../services/process";
import {
  buildFooterRenderData,
  renderFooter,
  type FooterPalette,
  type FooterRenderInput,
} from "./footer";
import {
  makeRefreshController,
  type FooterRefreshController,
} from "./refresh-controller";
import { JitterService, RateLimitReaderService } from "./services";

export interface CustomFooterHost {
  readonly requestRender: () => void;
}

export interface CustomFooterData {
  readonly getGitBranch: () => string | null;
  readonly getExtensionStatuses: () => ReadonlyMap<string, string>;
  readonly getAvailableProviderCount: () => number;
  readonly onBranchChange: (listener: () => void) => () => void;
}

export interface CustomFooterComponent {
  readonly render: (width: number) => string[];
  readonly invalidate: () => void;
  readonly dispose?: () => void;
}

export type CustomFooterFactory = (
  host: CustomFooterHost,
  palette: FooterPalette,
  footerData: CustomFooterData,
) => CustomFooterComponent;

export interface CustomFooterFeedback {
  readonly notify: (
    message: string,
    level: "info" | "warning" | "error",
  ) => void;
}

export interface CustomFooterContext {
  readonly mode: "tui" | "rpc" | "json" | "print";
  feedback?: CustomFooterFeedback;
  readonly setFooter: (factory: CustomFooterFactory | undefined) => void;
  readonly getRenderInput: (
    footerData: CustomFooterData,
    rateLimitStatus?: string,
  ) => FooterRenderInput;
}

type ContextHandler = (context: CustomFooterContext) => Promise<void>;

export interface CustomFooterRegistrationPort {
  readonly onSessionStart: (handler: ContextHandler) => void;
  readonly onTurnEnd: (handler: ContextHandler) => void;
  readonly onSessionShutdown: (handler: ContextHandler) => void;
  readonly registerCommand: (
    name: string,
    description: string,
    handler: ContextHandler,
  ) => void;
}

export interface CustomFooterControllerRuntime {
  readonly makeController: () => Promise<FooterRefreshController>;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly dispose: () => Promise<void>;
}

export type NativeFooterRenderInput = Omit<
  FooterRenderInput,
  "autoCompactEnabled"
>;

export const buildNativeFooterRenderInput = (
  input: NativeFooterRenderInput,
): FooterRenderInput => ({
  ...input,
  autoCompactEnabled: false,
});

export const registerCustomFooter = (
  port: CustomFooterRegistrationPort,
  runtime: CustomFooterControllerRuntime,
): void => {
  let controller: FooterRefreshController | undefined;
  let restoreFooter: (() => void) | undefined;
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  const sessionStart = async (context: CustomFooterContext): Promise<void> => {
    if (closed || context.mode !== "tui") return;

    if (controller === undefined) {
      controller = await runtime.makeController();
    } else {
      await runtime.runPromise(controller.shutdown);
      restoreFooter?.();
      restoreFooter = undefined;
    }

    const activeController = controller;
    let installedTarget: { readonly requestRender: () => void } | undefined;
    context.setFooter((host, palette, footerData) => {
      let rateLimitStatus: string | undefined;
      let disposed = false;
      const refreshCachedStatus = () => {
        void runtime
          .runPromise(activeController.getState)
          .then((state) => {
            rateLimitStatus = state.status;
            host.requestRender();
          })
          .catch(() => undefined);
      };
      const target = { requestRender: refreshCachedStatus };
      installedTarget = target;
      const branchListener = () => host.requestRender();
      const unsubscribeBranch = footerData.onBranchChange(branchListener);

      return {
        invalidate: () => host.requestRender(),
        render: (width) =>
          renderFooter(
            buildFooterRenderData(
              context.getRenderInput(footerData, rateLimitStatus),
            ),
            width,
            palette,
          ),
        dispose: () => {
          if (disposed) return;
          disposed = true;
          unsubscribeBranch();
          void runtime
            .runPromise(activeController.clearRenderTarget(target))
            .catch(() => undefined);
        },
      };
    });
    restoreFooter = () => context.setFooter(undefined);

    if (installedTarget !== undefined) {
      await runtime.runPromise(
        activeController.setRenderTarget(installedTarget),
      );
      installedTarget.requestRender();
    }
    await runtime.runPromise(activeController.start);
  };

  port.onSessionStart(sessionStart);

  port.onTurnEnd(async (context) => {
    if (closed || context.mode !== "tui" || controller === undefined) return;
    await runtime.runPromise(controller.refresh("turn-end"));
  });

  port.registerCommand(
    "custom-footer",
    "Refresh custom footer rate limits",
    async (context) => {
      if (context.mode !== "tui") {
        context.feedback?.notify(
          "Custom footer requires interactive TUI mode.",
          "warning",
        );
        return;
      }
      if (closed || controller === undefined) return;

      const result = await runtime.runPromise(controller.refresh("manual"));
      const outcome = result.outcome;
      if (outcome._tag === "Success") {
        context.feedback?.notify(
          `Custom footer refreshed: ${outcome.status}`,
          "info",
        );
      } else {
        context.feedback?.notify(
          `Custom footer refresh failed: ${outcome.message}`,
          "error",
        );
      }
    },
  );

  port.onSessionShutdown(() => {
    shutdownPromise ??= (async () => {
      closed = true;
      restoreFooter?.();
      restoreFooter = undefined;
      if (controller !== undefined) {
        await runtime.runPromise(controller.shutdown);
      }
      await runtime.dispose();
    })();
    return shutdownPromise;
  });
};

const infrastructureLayer = Layer.mergeAll(
  EnvironmentService.Live,
  HomeDirectoryService.Live,
  FileSystemService.Live,
  ProcessService.Live,
);

export const CustomFooterLiveLayer = Layer.merge(
  RateLimitReaderService.Live.pipe(Layer.provide(infrastructureLayer)),
  JitterService.Live,
);

const toFooterContext = (
  pi: ExtensionAPI,
  context: ExtensionContext,
): CustomFooterContext => ({
  mode: context.mode,
  ...(context.hasUI
    ? {
        feedback: {
          notify: (message, level) => context.ui.notify(message, level),
        },
      }
    : {}),
  setFooter: (factory) =>
    context.ui.setFooter(
      factory === undefined
        ? undefined
        : (tui, theme, footerData) =>
            factory(
              tui,
              {
                dim: (text) => theme.fg("dim", text),
                warning: (text) => theme.fg("warning", text),
                error: (text) => theme.fg("error", text),
              },
              footerData,
            ),
    ),
  getRenderInput: (footerData, rateLimitStatus) => {
    const model = context.model;
    const contextUsage = context.getContextUsage();
    const entries: FooterRenderInput["entries"] = context.sessionManager
      .getEntries()
      .map((entry) => {
        if (entry.type === "message" && entry.message.role === "assistant") {
          return {
            type: "message",
            message: {
              role: "assistant",
              usage: {
                input: entry.message.usage.input,
                output: entry.message.usage.output,
                cacheRead: entry.message.usage.cacheRead,
                cacheWrite: entry.message.usage.cacheWrite,
                cost: { total: entry.message.usage.cost.total },
              },
            },
          };
        }
        return { type: entry.type };
      });

    return buildNativeFooterRenderInput({
      cwd: context.sessionManager.getCwd(),
      homeDirectory: homedir(),
      entries,
      branch: footerData.getGitBranch() ?? undefined,
      sessionName: context.sessionManager.getSessionName(),
      ...(contextUsage === undefined ? {} : { contextUsage }),
      ...(model === undefined
        ? {}
        : {
            model: {
              id: model.id,
              provider: model.provider,
              reasoning: model.reasoning,
              contextWindow: model.contextWindow,
            },
          }),
      thinkingLevel: pi.getThinkingLevel(),
      availableProviderCount: footerData.getAvailableProviderCount(),
      extensionStatuses: footerData.getExtensionStatuses(),
      ...(rateLimitStatus === undefined ? {} : { rateLimitStatus }),
      usingSubscription:
        model === undefined ? false : context.modelRegistry.isUsingOAuth(model),
    });
  },
});

export default function customFooterExtension(pi: ExtensionAPI): void {
  const runner = makeEffectRunner(CustomFooterLiveLayer);
  const runtime: CustomFooterControllerRuntime = {
    makeController: () => runner.runPromise(makeRefreshController({})),
    runPromise: (effect) => runner.runPromise(effect),
    dispose: runner.dispose,
  };

  registerCustomFooter(
    {
      onSessionStart: (handler) =>
        pi.on("session_start", (_event, context) =>
          handler(toFooterContext(pi, context)),
        ),
      onTurnEnd: (handler) =>
        pi.on("turn_end", (_event, context) =>
          handler(toFooterContext(pi, context)),
        ),
      onSessionShutdown: (handler) =>
        pi.on("session_shutdown", (_event, context) =>
          handler(toFooterContext(pi, context)),
        ),
      registerCommand: (name, description, handler) =>
        pi.registerCommand(name, {
          description,
          handler: async (_args, context) =>
            handler(toFooterContext(pi, context)),
        }),
    },
    runtime,
  );
}
