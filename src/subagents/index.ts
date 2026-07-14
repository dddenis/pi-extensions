import { fileURLToPath } from "node:url";
import { clampThinkingLevel, StringEnum } from "@earendil-works/pi-ai";
import {
  resolveCliModel,
  type ExtensionAPI,
  type ResolveCliModelResult,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Effect, Either, Layer } from "effect";
import { Type, type Static } from "typebox";
import { makeEffectRunner } from "../lib/effect-runtime";
import { EnvironmentService } from "../services/environment";
import { FileSystemService } from "../services/file-system";
import { HomeDirectoryService } from "../services/home-directory";
import { ProcessService } from "../services/process";
import {
  SubagentBatch,
  type BatchExecutionResult,
  type BatchProgress,
} from "./batch";
import { completeSubagent, type CompletionToolResult } from "./completion";
import {
  AgentDefinitionError,
  ChildProcessError,
  CompletionValidationError,
  InvalidSubagentInput,
  InvalidWorkingDirectoryError,
  PiEventStreamError,
  RunStoreError,
  ToolProviderError,
  formatSubagentError,
  type SubagentError,
} from "./errors";
import type { ModelResolutionPort, ParentSnapshot } from "./preflight";
import {
  formatModelResult,
  renderSubagentCall,
  renderSubagentResult,
  type RenderTheme,
  type SubagentRenderDetails,
} from "./render";
import { RunExecutor } from "./run-executor";
import { RunStore } from "./run-store";
import {
  COMPLETION_SUMMARY_MAX_CODE_POINTS,
  type ThinkingLevel,
} from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";

const TaskParameters = Type.Object(
  {
    agent: Type.String({
      minLength: 1,
      description: "Agent definition name",
    }),
    task: Type.String({
      minLength: 1,
      description: "Task for the child agent",
    }),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Existing child working directory",
      }),
    ),
  },
  { additionalProperties: false },
);

const SubagentParameters = Type.Object(
  {
    tasks: Type.Array(TaskParameters, { minItems: 1, maxItems: 3 }),
  },
  { additionalProperties: false },
);

const CompletionParameters = Type.Object(
  {
    status: StringEnum([
      "DONE",
      "DONE_WITH_CONCERNS",
      "NEEDS_CONTEXT",
      "BLOCKED",
    ] as const),
    summary: Type.String({
      minLength: 1,
      description: `Concise single-line completion summary; after trimming, at most ${COMPLETION_SUMMARY_MAX_CODE_POINTS} Unicode code points`,
    }),
    reportPath: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Absolute path to an existing completion report",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface ParentToolExecutionContext {
  readonly cwd: string;
  readonly model?: {
    readonly provider: string;
    readonly id: string;
  };
  readonly resolveModel: CliModelResolver;
}

export interface ParentToolUpdate {
  readonly content: Array<{
    readonly type: "text";
    readonly text: string;
  }>;
  readonly details: SubagentRenderDetails;
}

export interface ParentToolDefinition {
  readonly name: "subagent";
  readonly label: string;
  readonly description: string;
  readonly parameters: typeof SubagentParameters;
  readonly executionMode: "sequential";
  readonly execute: (
    toolCallId: string,
    params: Static<typeof SubagentParameters>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ParentToolUpdate) => void) | undefined,
    context: ParentToolExecutionContext,
  ) => Promise<ParentToolUpdate>;
  readonly renderCall: (
    args: Static<typeof SubagentParameters>,
    theme: RenderTheme,
  ) => Component;
  readonly renderResult: (
    result: ParentToolUpdate,
    options: { readonly expanded: boolean; readonly isPartial: boolean },
    theme: RenderTheme,
  ) => Component;
}

export interface ParentToolRegistrationPort {
  readonly registerTool: (tool: ParentToolDefinition) => void;
  readonly onSessionShutdown: (handler: () => Promise<void>) => void;
  readonly getThinkingLevel: () => ThinkingLevel;
  readonly getAllTools: () => ReadonlyArray<{
    readonly name: string;
    readonly sourceInfo: {
      readonly path: string;
      readonly source: string;
      readonly baseDir?: string;
    };
  }>;
}

export interface CompletionToolDefinition {
  readonly name: "complete_subagent";
  readonly label: string;
  readonly description: string;
  readonly parameters: typeof CompletionParameters;
  readonly execute: (
    toolCallId: string,
    params: Static<typeof CompletionParameters>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ) => Promise<CompletionToolResult>;
}

export interface CompletionToolRegistrationPort {
  readonly registerTool: (tool: CompletionToolDefinition) => void;
  readonly onSessionShutdown: (handler: () => Promise<void>) => void;
}

export type CliModelResolverResult = ResolveCliModelResult;

export type CliModelResolver = (options: {
  readonly cliModel: string;
  readonly cliThinking: ThinkingLevel;
}) => CliModelResolverResult;

export interface ParentRuntimeInput {
  readonly request: unknown;
  readonly parent: ParentSnapshot;
  readonly models: ModelResolutionPort;
  readonly signal: AbortSignal | undefined;
  readonly onProgress: (progress: BatchProgress) => Promise<void>;
}

export interface ParentRuntime {
  readonly execute: (
    input: ParentRuntimeInput,
  ) => Promise<BatchExecutionResult>;
  readonly dispose: () => Promise<void>;
}

export interface CompletionRuntime {
  readonly execute: (
    input: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<CompletionToolResult>;
  readonly dispose: () => Promise<void>;
}

export interface ParentInvocationRunner {
  readonly runPromise: (
    effect: Effect.Effect<
      Either.Either<BatchExecutionResult, SubagentError>,
      never,
      SubagentBatch
    >,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Either.Either<BatchExecutionResult, SubagentError>>;
  readonly dispose: () => Promise<void>;
}

export type ParentInvocationRunnerFactory = (
  models: ModelResolutionPort,
) => ParentInvocationRunner;

export interface SubagentRuntimeFactories {
  readonly makeParentRuntime: () => ParentRuntime;
  readonly makeCompletionRuntime: () => CompletionRuntime;
}

export interface SubagentCompositionPorts {
  readonly parent: ParentToolRegistrationPort;
  readonly completion: CompletionToolRegistrationPort;
}

const isSubagentError = (error: unknown): error is SubagentError =>
  error instanceof InvalidSubagentInput ||
  error instanceof AgentDefinitionError ||
  error instanceof ToolProviderError ||
  error instanceof InvalidWorkingDirectoryError ||
  error instanceof RunStoreError ||
  error instanceof ChildProcessError ||
  error instanceof PiEventStreamError ||
  error instanceof CompletionValidationError;

const throwBoundaryError = (error: unknown): never => {
  if (isSubagentError(error)) {
    throw new Error(sanitizeTerminalText(formatSubagentError(error)));
  }
  if (error instanceof Error) {
    throw new Error(sanitizeTerminalText(error.message));
  }
  throw error;
};

const freezeDiagnostics = (
  diagnostics: ReadonlyArray<string>,
): ReadonlyArray<string> => Object.freeze([...diagnostics]);

const makeModelResolutionPort = (
  resolver: CliModelResolver,
  diagnostics: Array<string>,
): ModelResolutionPort => ({
  resolve: (pattern, thinking) =>
    Effect.sync(() =>
      resolver({
        cliModel: pattern,
        cliThinking: thinking,
      }),
    ).pipe(
      Effect.flatMap((resolution) => {
        if (resolution.warning !== undefined) {
          diagnostics.push(resolution.warning);
        }
        if (resolution.error !== undefined) {
          return Effect.fail(
            new InvalidSubagentInput({
              subject: pattern,
              field: "model",
              message: resolution.error,
            }),
          );
        }
        if (resolution.model === undefined) {
          return Effect.fail(
            new InvalidSubagentInput({
              subject: pattern,
              field: "model",
              message: "Model resolution returned no model",
            }),
          );
        }
        const requestedThinking = resolution.thinkingLevel ?? thinking;
        return Effect.succeed(
          Object.freeze({
            model: `${resolution.model.provider}/${resolution.model.id}`,
            thinking: clampThinkingLevel(resolution.model, requestedThinking),
          }),
        );
      }),
    ),
});

const snapshotParent = (
  port: ParentToolRegistrationPort,
  context: ParentToolExecutionContext,
): ParentSnapshot => {
  const tools = port.getAllTools().map(({ name, sourceInfo }) =>
    Object.freeze({
      name,
      source: sourceInfo.source,
      path: sourceInfo.path,
      ...(sourceInfo.baseDir === undefined
        ? {}
        : { baseDir: sourceInfo.baseDir }),
    }),
  );
  return Object.freeze({
    cwd: context.cwd,
    ...(context.model === undefined
      ? {}
      : { model: `${context.model.provider}/${context.model.id}` }),
    thinking: port.getThinkingLevel(),
    tools: Object.freeze(tools),
  });
};

const conciseProgress = (progress: BatchProgress): string => {
  const counts = {
    starting: 0,
    running: 0,
    settled: 0,
  };
  for (const child of progress.children) {
    switch (child.lifecycle) {
      case "STARTING":
        counts.starting += 1;
        break;
      case "RUNNING":
        counts.running += 1;
        break;
      case "SETTLED":
        counts.settled += 1;
        break;
    }
  }
  const parts = [
    counts.running === 0 ? undefined : `${counts.running} running`,
    counts.starting === 0 ? undefined : `${counts.starting} starting`,
    counts.settled === 0 ? undefined : `${counts.settled} settled`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0
    ? "Subagents: waiting"
    : `Subagents: ${parts.join(", ")}`;
};

export const registerParentTool = (
  port: ParentToolRegistrationPort,
  runtime: ParentRuntime,
): void => {
  let shutdownPromise: Promise<void> | undefined;
  port.onSessionShutdown(() => {
    shutdownPromise ??= runtime.dispose();
    return shutdownPromise;
  });

  port.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run one to three isolated child agents and return ordered structured results.",
    parameters: SubagentParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, onUpdate, context) => {
      const modelDiagnostics: Array<string> = [];
      const models = makeModelResolutionPort(
        context.resolveModel,
        modelDiagnostics,
      );
      try {
        const execution = await runtime.execute({
          request: params,
          parent: snapshotParent(port, context),
          models,
          signal,
          onProgress: async (progress) => {
            onUpdate?.({
              content: [{ type: "text", text: conciseProgress(progress) }],
              details: {
                phase: "progress",
                progress,
                diagnostics: freezeDiagnostics([
                  ...progress.diagnostics,
                  ...modelDiagnostics,
                ]),
              },
            });
          },
        });
        return {
          content: [
            { type: "text", text: formatModelResult(execution.results) },
          ],
          details: {
            phase: "complete",
            results: Object.freeze([...execution.results]),
            diagnostics: freezeDiagnostics([
              ...execution.diagnostics,
              ...modelDiagnostics,
            ]),
          },
        };
      } catch (error) {
        return throwBoundaryError(error);
      }
    },
    renderCall: (args, theme) => renderSubagentCall(args, theme),
    renderResult: (result, options, theme) =>
      renderSubagentResult(result, options, theme),
  });
};

export const registerCompletionTool = (
  port: CompletionToolRegistrationPort,
  runtime: CompletionRuntime,
): void => {
  let shutdownPromise: Promise<void> | undefined;
  port.onSessionShutdown(() => {
    shutdownPromise ??= runtime.dispose();
    return shutdownPromise;
  });

  port.registerTool({
    name: "complete_subagent",
    label: "Complete Subagent",
    description:
      "Record the child agent's final structured status and terminate its run.",
    parameters: CompletionParameters,
    execute: async (_toolCallId, params, signal) => {
      try {
        return await runtime.execute(params, signal);
      } catch (error) {
        return throwBoundaryError(error);
      }
    },
  });
};

const completionEntrypoint = fileURLToPath(import.meta.url);

const ParentInfrastructureLive = Layer.mergeAll(
  EnvironmentService.Live,
  HomeDirectoryService.Live,
  FileSystemService.Live,
  ProcessService.Live,
);

const makeParentLayer = (models: ModelResolutionPort) => {
  const runServices = Layer.merge(
    RunStore.Live,
    RunExecutor.layer({ completionEntrypoint }),
  ).pipe(Layer.provide(ParentInfrastructureLive));
  return SubagentBatch.layer(models).pipe(
    Layer.provide(Layer.merge(ParentInfrastructureLive, runServices)),
  );
};

const makeLiveParentInvocationRunner: ParentInvocationRunnerFactory = (
  models,
) => makeEffectRunner(makeParentLayer(models));

export const makeParentRuntime = (
  makeRunner: ParentInvocationRunnerFactory = makeLiveParentInvocationRunner,
): ParentRuntime => {
  interface ActiveInvocation {
    readonly abort: AbortController;
    readonly settled: Promise<void>;
  }

  const active = new Set<ActiveInvocation>();
  let disposal: Promise<void> | undefined;
  let closed = false;

  return {
    execute: async (input) => {
      if (closed) throw new Error("Subagent runtime is shut down");
      const runner = makeRunner(input.models);
      const abort = new AbortController();
      let markSettled: () => void = () => undefined;
      const settled = new Promise<void>((resolve) => {
        markSettled = resolve;
      });
      const invocation = { abort, settled };
      active.add(invocation);
      const interruptOnShutdown = Effect.async<never>((resume) => {
        const interrupt = (): void => resume(Effect.interrupt);
        if (abort.signal.aborted) {
          interrupt();
          return;
        }
        abort.signal.addEventListener("abort", interrupt, { once: true });
        return Effect.sync(() => {
          abort.signal.removeEventListener("abort", interrupt);
        });
      });

      try {
        const outcome = await runner.runPromise(
          Effect.raceFirst(
            Effect.either(
              Effect.flatMap(SubagentBatch, (batch) =>
                batch.execute(input.request, input.parent, (progress) =>
                  Effect.promise(() => input.onProgress(progress)),
                ),
              ),
            ),
            interruptOnShutdown,
          ),
          { signal: input.signal },
        );
        if (Either.isLeft(outcome)) throw outcome.left;
        return outcome.right;
      } finally {
        try {
          await runner.dispose();
        } finally {
          active.delete(invocation);
          markSettled();
        }
      }
    },
    dispose: () => {
      disposal ??= (async () => {
        closed = true;
        const invocations = [...active];
        for (const invocation of invocations) invocation.abort.abort();
        await Promise.all(invocations.map(({ settled }) => settled));
      })();
      return disposal;
    },
  };
};

const makeCompletionRuntime = (): CompletionRuntime => {
  const runner = makeEffectRunner(FileSystemService.Live);
  return {
    execute: async (input, signal) => {
      const outcome = await runner.runPromise(
        Effect.either(completeSubagent(input)),
        { signal },
      );
      if (Either.isLeft(outcome)) throw outcome.left;
      return outcome.right;
    },
    dispose: runner.dispose,
  };
};

const parentPort = (pi: ExtensionAPI): ParentToolRegistrationPort => ({
  registerTool: (definition) =>
    pi.registerTool<typeof SubagentParameters, SubagentRenderDetails>({
      ...definition,
      execute: async (toolCallId, params, signal, onUpdate, context) => {
        const result = await definition.execute(
          toolCallId,
          params,
          signal,
          (update) => onUpdate?.({ ...update, content: [...update.content] }),
          {
            cwd: context.cwd,
            ...(context.model === undefined ? {} : { model: context.model }),
            resolveModel: ({ cliModel, cliThinking }) =>
              resolveCliModel({
                cliModel,
                cliThinking,
                modelRegistry: context.modelRegistry,
              }),
          },
        );
        return { ...result, content: [...result.content] };
      },
      renderCall: (args, theme) => definition.renderCall(args, theme),
      renderResult: (result, options, theme) =>
        definition.renderResult(
          {
            content: result.content.flatMap((content) => {
              if (content.type !== "text") return [];
              const textContent: {
                readonly type: "text";
                readonly text: string;
              } = {
                type: "text",
                text: content.text,
              };
              return [textContent];
            }),
            details: result.details,
          },
          options,
          theme,
        ),
    }),
  onSessionShutdown: (handler) => {
    pi.on("session_shutdown", () => handler());
  },
  getThinkingLevel: () => pi.getThinkingLevel(),
  getAllTools: () => pi.getAllTools(),
});

const completionPort = (pi: ExtensionAPI): CompletionToolRegistrationPort => ({
  registerTool: (definition) =>
    pi.registerTool<
      typeof CompletionParameters,
      CompletionToolResult["details"]
    >({
      ...definition,
      execute: async (toolCallId, params, signal, _onUpdate, context) => {
        const result = await definition.execute(
          toolCallId,
          params,
          signal,
          undefined,
          context,
        );
        return { ...result, content: [...result.content] };
      },
    }),
  onSessionShutdown: (handler) => {
    pi.on("session_shutdown", () => handler());
  },
});

export const registerSubagentsForEnvironment = (
  childMarker: string | undefined,
  ports: SubagentCompositionPorts,
  factories: SubagentRuntimeFactories,
): void => {
  if (childMarker === "1") {
    registerCompletionTool(ports.completion, factories.makeCompletionRuntime());
    return;
  }
  registerParentTool(ports.parent, factories.makeParentRuntime());
};

const LiveRuntimeFactories: SubagentRuntimeFactories = {
  makeParentRuntime: () => makeParentRuntime(),
  makeCompletionRuntime,
};

export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagentsForEnvironment(
    process.env.PI_SUBAGENT_CHILD,
    { parent: parentPort(pi), completion: completionPort(pi) },
    LiveRuntimeFactories,
  );
}
