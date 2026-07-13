import {
  Clock,
  Context,
  DateTime,
  Effect,
  Either,
  Exit,
  Layer,
  Ref,
  Scope,
} from "effect";
import { type EnvironmentService } from "../services/environment";
import { type FileSystemService } from "../services/file-system";
import { type HomeDirectoryService } from "../services/home-directory";
import {
  type AgentDefinitionDiagnostic,
  type AgentDiscovery,
  discoverAgents,
} from "./agents";
import {
  AgentDefinitionError,
  ChildProcessError,
  CompletionValidationError,
  InvalidSubagentInput,
  InvalidWorkingDirectoryError,
  PiEventStreamError,
  RunStoreError,
  ToolProviderError,
  UnsafeReaderError,
  WriterPolicyError,
  formatSubagentError,
  type SubagentError,
} from "./errors";
import {
  type ModelResolutionPort,
  type ParentSnapshot,
  type ResolvedTask,
  preflight,
} from "./preflight";
import { makeChildProgress, type ChildProgress } from "./progress";
import {
  RunExecutor,
  type RunExecutor as RunExecutorService,
} from "./run-executor";
import {
  INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
  RunStore,
  type ActiveRunStore,
  type RunStore as RunStoreService,
} from "./run-store";
import {
  COMPLETION_SUMMARY_MAX_CODE_POINTS,
  decodeSubagentRequest,
  type RunResult,
  type SubagentRequest,
} from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";

export interface BatchProgress {
  readonly children: ReadonlyArray<ChildProgress>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface BatchExecutionResult {
  readonly results: ReadonlyArray<RunResult>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface SubagentBatch {
  readonly execute: (
    request: unknown,
    parent: ParentSnapshot,
    onProgress: (progress: BatchProgress) => Effect.Effect<void>,
  ) => Effect.Effect<BatchExecutionResult, SubagentError>;
}

export interface BatchPreflightInput {
  readonly request: SubagentRequest;
  readonly discovery: AgentDiscovery;
  readonly parent: ParentSnapshot;
}

export interface BatchOrchestrationPorts {
  readonly discover: Effect.Effect<AgentDiscovery, SubagentError>;
  readonly preflight: (
    input: BatchPreflightInput,
  ) => Effect.Effect<ReadonlyArray<ResolvedTask>, SubagentError>;
  readonly store: RunStoreService;
  readonly executor: RunExecutorService;
}

interface CreatedRun {
  readonly task: ResolvedTask;
  readonly run: ActiveRunStore;
}

const SubagentBatchTag = Context.GenericTag<SubagentBatch>(
  "pi-extensions/subagents/SubagentBatch",
);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const decodeRequest = (
  request: unknown,
): Effect.Effect<SubagentRequest, InvalidSubagentInput> =>
  Effect.try({
    try: () => decodeSubagentRequest(request),
    catch: (error) =>
      new InvalidSubagentInput({
        subject: "request",
        message: errorMessage(error),
      }),
  });

const timestamp: Effect.Effect<string> = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.unsafeMake(millis))),
);

const rollbackSummary = (error: SubagentError): string =>
  Array.from(
    sanitizeTerminalText(
      `Batch infrastructure failure: ${formatSubagentError(error)}`,
    )
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, COMPLETION_SUMMARY_MAX_CODE_POINTS)
    .join("");

const rollbackCreated = (
  created: ReadonlyArray<CreatedRun>,
  primary: SubagentError,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const updatedAt = yield* timestamp;
      const primaryDiagnostic = formatSubagentError(primary)
        .replace(/\s+/gu, " ")
        .trim();
      const diagnostics: Array<string> = [];
      yield* Effect.forEach(
        created,
        ({ run }) =>
          run
            .transition({
              status: "FAILED",
              updatedAt,
              summary: rollbackSummary(primary),
              diagnostics: [
                primaryDiagnostic,
                INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
              ],
            })
            .pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  diagnostics.push(formatSubagentError(error));
                }),
              ),
              Effect.asVoid,
            ),
        { concurrency: 1, discard: true },
      );
      return Object.freeze([...diagnostics]);
    }),
  );

const withErrorMessage = (
  error: SubagentError,
  message: string,
): SubagentError => {
  switch (error._tag) {
    case "InvalidSubagentInput":
      return new InvalidSubagentInput({
        subject: error.subject,
        message,
        ...(error.field === undefined ? {} : { field: error.field }),
      });
    case "AgentDefinitionError":
      return new AgentDefinitionError({
        definitionPath: error.definitionPath,
        definitionPaths: error.definitionPaths,
        diagnostics: error.diagnostics,
        reason: error.reason,
        message,
        ...(error.agentName === undefined
          ? {}
          : { agentName: error.agentName }),
      });
    case "UnsafeReaderError":
      return new UnsafeReaderError({
        agentName: error.agentName,
        message,
        ...(error.tools === undefined ? {} : { tools: error.tools }),
      });
    case "ToolProviderError":
      return new ToolProviderError({
        toolName: error.toolName,
        message,
        ...(error.source === undefined ? {} : { source: error.source }),
        ...(error.providerPath === undefined
          ? {}
          : { providerPath: error.providerPath }),
      });
    case "InvalidWorkingDirectoryError":
      return new InvalidWorkingDirectoryError({ cwd: error.cwd, message });
    case "WriterPolicyError":
      return new WriterPolicyError({
        message,
        writerCount: error.writerCount,
        ...(error.agents === undefined ? {} : { agents: error.agents }),
      });
    case "RunStoreError":
      return new RunStoreError({
        operation: error.operation,
        path: error.path,
        message,
        ...(error.runId === undefined ? {} : { runId: error.runId }),
      });
    case "ChildProcessError":
      return new ChildProcessError({
        operation: error.operation,
        message,
        ...(error.runId === undefined ? {} : { runId: error.runId }),
        ...(error.agent === undefined ? {} : { agent: error.agent }),
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
        ...(error.signal === undefined ? {} : { signal: error.signal }),
      });
    case "PiEventStreamError":
      return new PiEventStreamError({
        message,
        ...(error.runId === undefined ? {} : { runId: error.runId }),
        ...(error.lineNumber === undefined
          ? {}
          : { lineNumber: error.lineNumber }),
        ...(error.rawLine === undefined ? {} : { rawLine: error.rawLine }),
      });
    case "CompletionValidationError":
      return new CompletionValidationError({
        message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.reportPath === undefined
          ? {}
          : { reportPath: error.reportPath }),
        ...(error.summary === undefined ? {} : { summary: error.summary }),
      });
  }
};

const appendRollbackDiagnostics = (
  error: SubagentError,
  diagnostics: ReadonlyArray<string>,
): SubagentError =>
  diagnostics.length === 0
    ? error
    : withErrorMessage(
        error,
        `${error.message}; rollback status diagnostics: ${diagnostics.join("; ")}`,
      );

const abortCreated = (
  created: ReadonlyArray<CreatedRun>,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    timestamp.pipe(
      Effect.flatMap((updatedAt) =>
        Effect.forEach(
          created,
          ({ run }) =>
            run
              .transition({
                status: "ABORTED",
                updatedAt,
                summary: "Parent cancelled subagent run",
              })
              .pipe(Effect.ignore),
          { concurrency: 3, discard: true },
        ),
      ),
    ),
  );

const orderedResults = (
  outcomes: ReadonlyArray<Either.Either<RunResult, SubagentError>>,
): Effect.Effect<ReadonlyArray<RunResult>, SubagentError> => {
  const results: Array<RunResult> = [];
  let primary: SubagentError | undefined;
  const additionalDiagnostics: Array<string> = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (Either.isLeft(outcome)) {
      if (primary === undefined) {
        primary = outcome.left;
      } else {
        additionalDiagnostics.push(
          `child[${index}] ${formatSubagentError(outcome.left)}`,
        );
      }
    } else {
      results.push(outcome.right);
    }
  }
  if (primary !== undefined) {
    return Effect.fail(
      additionalDiagnostics.length === 0
        ? primary
        : withErrorMessage(
            primary,
            `${primary.message}; additional await failures: ${additionalDiagnostics.join("; ")}`,
          ),
    );
  }
  return Effect.succeed(Object.freeze(results));
};

const formatDiscoveryDiagnostic = (
  diagnostic: AgentDefinitionDiagnostic,
): string =>
  `${diagnostic.agentName === undefined ? "agent definition" : `agent ${diagnostic.agentName}`} (${diagnostic.definitionPath}): ${diagnostic.message}`;

const copyProgressItem = (
  item: ChildProgress["items"][number],
): ChildProgress["items"][number] =>
  item.type === "assistant"
    ? Object.freeze({ type: "assistant", text: item.text })
    : Object.freeze({
        type: "tool",
        name: item.name,
        preview: item.preview,
      });

const copyChildProgress = (progress: ChildProgress): ChildProgress =>
  Object.freeze({
    runId: progress.runId,
    agent: progress.agent,
    lifecycle: progress.lifecycle,
    items: Object.freeze(progress.items.map(copyProgressItem)),
    usage: Object.freeze({ ...progress.usage }),
  });

export const makeSubagentBatch = (
  ports: BatchOrchestrationPorts,
): SubagentBatch => {
  const service: SubagentBatch = {
    execute: (request, parent, onProgress) =>
      Effect.gen(function* () {
        const decoded = yield* decodeRequest(request);
        const discovery = yield* ports.discover;
        const tasks = yield* ports.preflight({
          request: decoded,
          discovery,
          parent,
        });
        const diagnostics = Object.freeze(
          discovery.diagnostics.map(formatDiscoveryDiagnostic),
        );
        const created: Array<CreatedRun> = [];
        const executionScope = yield* Scope.make();
        const launchBarrierPassed = yield* Ref.make(false);

        const execution = Effect.gen(function* () {
          for (const task of tasks) {
            yield* Effect.uninterruptible(
              ports.store.create(task).pipe(
                Effect.tap((run) =>
                  Effect.sync(() => {
                    created.push({ task, run });
                  }),
                ),
              ),
            );
          }

          const progress = yield* Ref.make<ReadonlyArray<ChildProgress>>(
            created.map(({ task, run }) =>
              copyChildProgress(
                makeChildProgress(run.artifacts.runId, task.agent.name)
                  .snapshot,
              ),
            ),
          );
          const progressPublication = yield* Effect.makeSemaphore(1);
          const publish = (
            index: number,
            snapshot: ChildProgress,
          ): Effect.Effect<void> =>
            progressPublication.withPermits(1)(
              Ref.modify(progress, (current) => {
                const stored = copyChildProgress(snapshot);
                const children = Object.freeze(
                  current.map((child, childIndex) =>
                    childIndex === index ? stored : child,
                  ),
                );
                const published = Object.freeze({
                  children: Object.freeze(children.map(copyChildProgress)),
                  diagnostics,
                });
                return [published, children];
              }).pipe(
                Effect.flatMap((published) =>
                  Effect.suspend(() => onProgress(published)),
                ),
              ),
            );

          const handles = yield* Effect.forEach(
            created,
            ({ task, run }, index) =>
              Scope.extend(
                ports.executor.launch(task, run, (snapshot) =>
                  publish(index, snapshot),
                ),
                executionScope,
              ),
            { concurrency: 3 },
          );

          yield* Effect.forEach(handles, (handle) => handle.launched, {
            concurrency: 3,
            discard: true,
          });
          yield* Ref.set(launchBarrierPassed, true);

          const outcomes = yield* Effect.forEach(
            handles,
            (handle) => Effect.either(handle.awaitResult),
            { concurrency: 3 },
          );
          return yield* orderedResults(outcomes);
        }).pipe(
          Effect.catchAll((error) =>
            Ref.get(launchBarrierPassed).pipe(
              Effect.flatMap((passed) => {
                if (passed) return Effect.fail(error);
                return rollbackCreated(created, error).pipe(
                  Effect.flatMap((diagnostics) =>
                    Scope.close(executionScope, Exit.void).pipe(
                      Effect.zipRight(
                        Effect.fail(
                          appendRollbackDiagnostics(error, diagnostics),
                        ),
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),
          Effect.onInterrupt(() => abortCreated(created)),
          Effect.ensuring(Scope.close(executionScope, Exit.void)),
        );

        const results = yield* execution;
        return Object.freeze({ results, diagnostics });
      }),
  };
  return Object.freeze(service);
};

const makeLive = (
  models: ModelResolutionPort,
): Effect.Effect<
  SubagentBatch,
  never,
  | RunStoreService
  | RunExecutorService
  | FileSystemService
  | EnvironmentService
  | HomeDirectoryService
> =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const executor = yield* RunExecutor;
    const infrastructure = yield* Effect.context<
      FileSystemService | EnvironmentService | HomeDirectoryService
    >();
    return makeSubagentBatch({
      discover: discoverAgents.pipe(Effect.provide(infrastructure)),
      preflight: ({ request, discovery, parent }) =>
        preflight({ request, discovery, parent, models }).pipe(
          Effect.provide(infrastructure),
        ),
      store,
      executor,
    });
  });

const layer = (models: ModelResolutionPort) =>
  Layer.effect(SubagentBatchTag, makeLive(models));

export const SubagentBatch = Object.assign(SubagentBatchTag, { layer });
