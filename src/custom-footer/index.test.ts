import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { buildFooterRenderData } from "./footer";
import {
  buildNativeFooterRenderInput,
  registerCustomFooter,
  type CustomFooterComponent,
  type CustomFooterContext,
  type CustomFooterControllerRuntime,
  type CustomFooterFactory,
  type CustomFooterRegistrationPort,
} from "./index";
import type {
  FooterRefreshController,
  FooterRefreshState,
  RefreshCause,
  RefreshOutcome,
  RenderTarget,
} from "./refresh-controller";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

interface ControllerState {
  starts: number;
  intervals: number;
  requests: RefreshCause[];
  shutdowns: number;
  targets: RenderTarget[];
  clearedTargets: RenderTarget[];
  outcome: RefreshOutcome;
}

const makeController = (
  order: string[],
): { controller: FooterRefreshController; state: ControllerState } => {
  const state: ControllerState = {
    starts: 0,
    intervals: 0,
    requests: [],
    shutdowns: 0,
    targets: [],
    clearedTargets: [],
    outcome: { _tag: "Success", status: "OpenAI 5h 99% | wk 92%" },
  };
  const footerState: FooterRefreshState = { stale: false, failureCount: 0 };
  function refresh(cause: "startup" | "wake" | "manual"): Effect.Effect<{
    readonly _tag: "Attempted";
    readonly outcome: RefreshOutcome;
  }>;
  function refresh(cause: RefreshCause): Effect.Effect<{
    readonly _tag: "Attempted";
    readonly outcome: RefreshOutcome;
  }>;
  function refresh(cause: RefreshCause): Effect.Effect<{
    readonly _tag: "Attempted";
    readonly outcome: RefreshOutcome;
  }> {
    return Effect.sync(() => {
      state.requests.push(cause);
      return { _tag: "Attempted", outcome: state.outcome };
    });
  }

  const controller: FooterRefreshController = {
    getState: Effect.sync(() => footerState),
    refresh,
    start: Effect.sync(() => {
      state.starts += 1;
      state.intervals += 1;
      order.push("start");
    }),
    setRenderTarget: (target) =>
      Effect.sync(() => {
        state.targets.push(target);
      }),
    clearRenderTarget: (target) =>
      Effect.sync(() => {
        state.clearedTargets.push(target);
      }),
    shutdown: Effect.sync(() => {
      state.shutdowns += 1;
      order.push("controller.shutdown");
    }),
  };
  return { controller, state };
};

const makeHarness = (mode: CustomFooterContext["mode"] = "tui") => {
  const order: string[] = [];
  const made = makeController(order);
  let disposed = 0;
  const runtime: CustomFooterControllerRuntime = {
    makeController: async () => made.controller,
    runPromise: (effect) => Effect.runPromise(effect),
    dispose: async () => {
      disposed += 1;
      order.push("runtime.dispose");
    },
  };

  let start: ((ctx: CustomFooterContext) => Promise<void>) | undefined;
  let turnEnd: ((ctx: CustomFooterContext) => Promise<void>) | undefined;
  let shutdown: ((ctx: CustomFooterContext) => Promise<void>) | undefined;
  let command: ((ctx: CustomFooterContext) => Promise<void>) | undefined;
  const port: CustomFooterRegistrationPort = {
    onSessionStart: (handler) => {
      start = handler;
    },
    onTurnEnd: (handler) => {
      turnEnd = handler;
    },
    onSessionShutdown: (handler) => {
      shutdown = handler;
    },
    registerCommand: (name, description, handler) => {
      expect(name).toBe("custom-footer");
      expect(description).toBe("Refresh custom footer rate limits");
      command = handler;
    },
  };

  let footerFactory: CustomFooterFactory | undefined;
  let component: CustomFooterComponent | undefined;
  let unsubscribeCalls = 0;
  let subscribedListener: (() => void) | undefined;
  const notifications: Array<readonly [string, "info" | "warning" | "error"]> =
    [];
  let renders = 0;
  const context: CustomFooterContext = {
    mode,
    feedback: {
      notify: (message, level) => notifications.push([message, level]),
    },
    setFooter: (factory) => {
      order.push(factory === undefined ? "restore-footer" : "install-footer");
      component?.dispose?.();
      component = undefined;
      footerFactory = factory;
      if (factory !== undefined) {
        component = factory(
          { requestRender: () => (renders += 1) },
          {
            dim: (text) => text,
            warning: (text) => text,
            error: (text) => text,
          },
          {
            getGitBranch: () => "main",
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 1,
            onBranchChange: (listener) => {
              subscribedListener = listener;
              return () => {
                unsubscribeCalls += 1;
              };
            },
          },
        );
      }
    },
    getRenderInput: (footerData, rateLimitStatus) => ({
      cwd: "/home/me/project",
      homeDirectory: "/home/me",
      entries: [],
      branch: footerData.getGitBranch() ?? undefined,
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
      model: {
        id: "gpt-5.4",
        provider: "openai-codex",
        reasoning: true,
        contextWindow: 200_000,
      },
      thinkingLevel: "high",
      availableProviderCount: footerData.getAvailableProviderCount(),
      extensionStatuses: footerData.getExtensionStatuses(),
      rateLimitStatus,
      usingSubscription: true,
      autoCompactEnabled: true,
    }),
  };

  registerCustomFooter(port, runtime);

  const required = <A>(value: A | undefined, name: string): A => {
    if (value === undefined) throw new Error(`${name} was not registered`);
    return value;
  };

  return {
    order,
    controllerState: made.state,
    context,
    notifications,
    get disposed() {
      return disposed;
    },
    get component() {
      return component;
    },
    get footerFactory() {
      return footerFactory;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get subscribedListener() {
      return subscribedListener;
    },
    get renders() {
      return renders;
    },
    start: () => required(start, "session_start")(context),
    turnEnd: () => required(turnEnd, "turn_end")(context),
    shutdown: () => required(shutdown, "session_shutdown")(context),
    command: () => required(command, "command")(context),
  };
};

describe("custom footer Pi boundary", () => {
  it("does not claim native auto-compaction without public evidence", () => {
    const renderInput = buildNativeFooterRenderInput({
      cwd: "/home/me/project",
      homeDirectory: "/home/me",
      entries: [],
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
      availableProviderCount: 1,
      extensionStatuses: new Map(),
      usingSubscription: false,
    });

    expect(renderInput.autoCompactEnabled).toBe(false);
    expect(buildFooterRenderData(renderInput).stats.at(-1)?.text).toBe(
      "? (200k)",
    );
  });

  it("does not install or start in RPC even when feedback exists", async () => {
    const harness = makeHarness("rpc");
    await harness.start();
    expect(harness.footerFactory).toBeUndefined();
    expect(harness.controllerState.starts).toBe(0);
  });

  it("installs once in TUI and delegates initial refresh and interval ownership to start", async () => {
    const harness = makeHarness();
    await harness.start();
    expect(harness.footerFactory).toBeDefined();
    expect(harness.controllerState.starts).toBe(1);
    expect(harness.controllerState.intervals).toBe(1);
    expect(harness.controllerState.targets).toHaveLength(1);
    expect(harness.subscribedListener).toBeDefined();
  });

  it("requests a turn-end refresh on turn completion", async () => {
    const harness = makeHarness();
    await harness.start();
    await harness.turnEnd();
    expect(harness.controllerState.requests).toEqual(["turn-end"]);
  });

  it("manually refreshes with exact success and failure notifications", async () => {
    const harness = makeHarness();
    await harness.start();
    await harness.command();
    expect(harness.controllerState.requests).toEqual(["manual"]);
    expect(harness.notifications.at(-1)).toEqual([
      "Custom footer refreshed: OpenAI 5h 99% | wk 92%",
      "info",
    ]);

    harness.controllerState.outcome = {
      _tag: "Failure",
      message: "Codex timed out",
    };
    await harness.command();
    expect(harness.controllerState.requests).toEqual(["manual", "manual"]);
    expect(harness.notifications.at(-1)).toEqual([
      "Custom footer refresh failed: Codex timed out",
      "error",
    ]);
  });

  it("never creates a controller outside TUI and warns only with feedback", async () => {
    const rpc = makeHarness("rpc");
    await rpc.command();
    expect(rpc.controllerState.requests).toEqual([]);
    expect(rpc.notifications).toEqual([
      ["Custom footer requires interactive TUI mode.", "warning"],
    ]);

    const print = makeHarness("print");
    print.context.feedback = undefined;
    await print.command();
    expect(print.notifications).toEqual([]);
    expect(print.controllerState.requests).toEqual([]);
  });

  it("uses exact branch and render-target identities during replacement", async () => {
    const harness = makeHarness();
    await harness.start();
    const oldComponent = harness.component;
    const oldTarget = harness.controllerState.targets[0];
    expect(oldComponent).toBeDefined();
    expect(oldTarget).toBeDefined();

    await harness.start();
    await flush();
    expect(harness.unsubscribeCalls).toBe(1);
    expect(harness.controllerState.clearedTargets).toContain(oldTarget);
    expect(harness.controllerState.targets).toHaveLength(2);
    expect(harness.controllerState.starts).toBe(2);
    expect(harness.controllerState.shutdowns).toBe(1);

    oldComponent?.dispose?.();
    await flush();
    expect(harness.controllerState.clearedTargets.at(-1)).toBe(oldTarget);
    harness.controllerState.targets.at(-1)?.requestRender();
    await flush();
    expect(harness.renders).toBeGreaterThan(0);
  });

  it("restores the footer, stops controller work, then disposes runtime once", async () => {
    const harness = makeHarness();
    await harness.start();
    await harness.shutdown();
    await harness.shutdown();
    await flush();

    expect(harness.order.slice(-3)).toEqual([
      "restore-footer",
      "controller.shutdown",
      "runtime.dispose",
    ]);
    expect(harness.unsubscribeCalls).toBe(1);
    expect(harness.controllerState.shutdowns).toBe(1);
    expect(harness.disposed).toBe(1);
  });
});
