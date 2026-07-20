import { Type, type Static } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  Context,
  Effect,
  ExecutionStrategy,
  Fiber,
  Layer,
  Scope,
} from "effect";
import { makeEffectRunner } from "../lib/effect-runtime";
import { ProcessService } from "../services/process";
import {
  buildChildCommand,
  type ChildCommand,
  type ParentSnapshot,
} from "./child-command";
import { executeBatch, type ExecuteBatchInput } from "./execution";
import {
  formatProgress,
  formatSubagentResults,
  type SubagentTaskResult,
} from "./output";

const NonBlankString = Type.String({ pattern: "\\S" });

export const SubagentTaskSchema = Type.Object(
  {
    description: NonBlankString,
    prompt: NonBlankString,
    cwd: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SubagentRequestSchema = Type.Object(
  {
    tasks: Type.Array(SubagentTaskSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type SubagentRequest = Static<typeof SubagentRequestSchema>;

export type SubagentToolDetails =
  | {
      readonly _tag: "Progress";
      readonly completed: number;
      readonly total: number;
    }
  | {
      readonly _tag: "Complete";
      readonly results: ReadonlyArray<SubagentTaskResult>;
    };

interface SubagentRuntimeState {
  readonly semaphore: Effect.Semaphore;
  readonly workScope: Scope.CloseableScope;
}

const SubagentRuntimeState = Context.GenericTag<SubagentRuntimeState>(
  "pi-extensions/SubagentRuntimeState",
);

export const SubagentRuntimeStateLive = Layer.scoped(
  SubagentRuntimeState,
  Effect.gen(function* () {
    const semaphore = yield* Effect.makeSemaphore(3);
    const workScope = yield* Scope.make(ExecutionStrategy.parallel);
    yield* Effect.addFinalizer((exit) => Scope.close(workScope, exit));
    return { semaphore, workScope };
  }),
);

export const SubagentLiveLayer = Layer.merge(
  ProcessService.Live,
  SubagentRuntimeStateLive,
);

const runInvocation = (
  input: Omit<ExecuteBatchInput, "semaphore">,
): Effect.Effect<
  ReadonlyArray<SubagentTaskResult>,
  never,
  ProcessService | SubagentRuntimeState
> =>
  Effect.gen(function* () {
    const state = yield* SubagentRuntimeState;
    const fiber = yield* Effect.acquireRelease(
      Effect.forkIn(
        executeBatch({ ...input, semaphore: state.semaphore }).pipe(
          Effect.interruptible,
        ),
        state.workScope,
      ),
      (active) => Fiber.interrupt(active).pipe(Effect.asVoid),
    );
    return yield* Fiber.join(fiber);
  }).pipe(Effect.scoped);

type SubagentDependencies = ProcessService | SubagentRuntimeState;

export interface SubagentEffectRunner {
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, SubagentDependencies>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<A>;
  readonly dispose: () => Promise<void>;
}

export interface SubagentRuntime {
  readonly run: (
    input: Omit<ExecuteBatchInput, "semaphore">,
    signal: AbortSignal | undefined,
  ) => Promise<ReadonlyArray<SubagentTaskResult>>;
  readonly dispose: () => Promise<void>;
}

export const makeSubagentRuntime = (
  runner: SubagentEffectRunner,
): SubagentRuntime => ({
  run: (input, signal) =>
    runner.runPromise(
      runInvocation(input),
      signal === undefined ? undefined : { signal },
    ),
  dispose: runner.dispose,
});

type SubagentToolResult = AgentToolResult<SubagentToolDetails>;
type SubagentUpdate = (result: SubagentToolResult) => void;

export interface SubagentParentContext {
  readonly cwd: string;
  readonly model?: {
    readonly provider: string;
    readonly id: string;
  };
}

export interface RegisteredSubagentTool {
  readonly name: "subagent";
  readonly label: string;
  readonly description: string;
  readonly parameters: typeof SubagentRequestSchema;
  readonly executionMode: "parallel";
  readonly execute: (
    params: SubagentRequest,
    signal: AbortSignal | undefined,
    onUpdate: SubagentUpdate | undefined,
    context: SubagentParentContext,
  ) => Promise<SubagentToolResult>;
}

export interface SubagentRegistrationPort {
  readonly registerTool: (tool: RegisteredSubagentTool) => void;
  readonly onSessionShutdown: (handler: () => Promise<void>) => void;
  readonly getThinkingLevel: () => string;
}

const publishProgress = (
  update: SubagentUpdate | undefined,
  completed: number,
  total: number,
): void => {
  try {
    update?.({
      content: [{ type: "text", text: formatProgress(completed, total) }],
      details: { _tag: "Progress", completed, total },
    });
  } catch {
    // Pi progress callbacks are advisory and cannot change task execution.
  }
};

export const registerSubagent = (
  port: SubagentRegistrationPort,
  runtime: SubagentRuntime,
  commandBuilder: (
    snapshot: ParentSnapshot,
  ) => ChildCommand = buildChildCommand,
): void => {
  port.registerTool({
    name: "subagent",
    label: "Subagents",
    description:
      "Run one or more isolated Pi coding tasks and return ordered bounded results.",
    parameters: SubagentRequestSchema,
    executionMode: "parallel",
    execute: async (params, signal, onUpdate, context) => {
      const model = context.model;
      if (model === undefined) {
        throw new Error("subagent requires an active parent model");
      }

      const snapshot: ParentSnapshot = {
        provider: model.provider,
        modelId: model.id,
        thinkingLevel: port.getThinkingLevel(),
      };
      const command = commandBuilder(snapshot);
      const total = params.tasks.length;
      publishProgress(onUpdate, 0, total);

      const results = await runtime.run(
        {
          tasks: params.tasks,
          parentCwd: context.cwd,
          command,
          onTaskSettled: (completed) =>
            publishProgress(onUpdate, completed, total),
        },
        signal,
      );

      return {
        content: [{ type: "text", text: formatSubagentResults(results) }],
        details: { _tag: "Complete", results },
      };
    },
  });

  let shutdownPromise: Promise<void> | undefined;
  port.onSessionShutdown(() => {
    shutdownPromise ??= runtime.dispose();
    return shutdownPromise;
  });
};

const toParentContext = (context: ExtensionContext): SubagentParentContext => {
  const model = context.model;
  return {
    cwd: context.cwd,
    ...(model === undefined
      ? {}
      : { model: { provider: model.provider, id: model.id } }),
  };
};

export default function subagentExtension(pi: ExtensionAPI): void {
  const runtime = makeSubagentRuntime(makeEffectRunner(SubagentLiveLayer));

  registerSubagent(
    {
      registerTool: (tool) => {
        const nativeTool: ToolDefinition<
          typeof SubagentRequestSchema,
          SubagentToolDetails
        > = {
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: tool.parameters,
          executionMode: tool.executionMode,
          execute: (_toolCallId, params, signal, onUpdate, context) =>
            tool.execute(params, signal, onUpdate, toParentContext(context)),
        };
        pi.registerTool(nativeTool);
      },
      onSessionShutdown: (handler) =>
        pi.on("session_shutdown", () => handler()),
      getThinkingLevel: () => pi.getThinkingLevel(),
    },
    runtime,
  );
}
