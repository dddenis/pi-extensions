import { randomUUID } from "node:crypto";
import path from "node:path";
import { Clock, Context, DateTime, Effect, Layer } from "effect";
import { resolveAgentDirectoryEffect } from "../lib/agent-directory";
import type { EnvironmentService } from "../services/environment";
import {
  type FileSystemError,
  FileSystemService,
} from "../services/file-system";
import type { HomeDirectoryService } from "../services/home-directory";
import { RunStoreError } from "./errors";
import type { ResolvedTask } from "./preflight";
import {
  type RunArtifacts,
  type RunManifest,
  type RunStatus,
  type RunStatusRecord,
  decodeRunManifest,
  decodeRunStatusRecord,
  decodeRunStatusRecordJson,
} from "./schemas";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export const INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC = "infrastructure-rollback";

const NESTED_DELEGATION_PROMPT =
  "Do not launch subagents or delegate this task. Complete it yourself.";

const STRUCTURED_COMPLETION_PROMPT =
  "Before finishing, call complete_subagent exactly once as your sole final tool call. Use status DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED; provide a concise single-line summary; and provide an absolute reportPath when a report is required.";

const terminalStatuses: ReadonlySet<RunStatus> = new Set([
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
  "FAILED",
  "ABORTED",
]);

export interface RunIdFactory {
  readonly generate: Effect.Effect<string>;
}

const RunIdFactoryTag = Context.GenericTag<RunIdFactory>(
  "pi-extensions/subagents/RunIdFactory",
);

export const RunIdFactory = Object.assign(RunIdFactoryTag, {
  Live: Layer.succeed(RunIdFactoryTag, {
    generate: Effect.sync(randomUUID),
  } satisfies RunIdFactory),
});

export interface ActiveRunStore {
  readonly artifacts: RunArtifacts;
  readonly transition: (
    record: RunStatusRecord,
  ) => Effect.Effect<boolean, RunStoreError>;
  readonly readStatus: Effect.Effect<RunStatusRecord, RunStoreError>;
  readonly appendEvent: (rawLine: string) => Effect.Effect<void, RunStoreError>;
  readonly appendStderr: (chunk: string) => Effect.Effect<void, RunStoreError>;
}

export interface RunStore {
  readonly create: (
    task: ResolvedTask,
  ) => Effect.Effect<ActiveRunStore, RunStoreError>;
}

const RunStoreTag = Context.GenericTag<RunStore>(
  "pi-extensions/subagents/RunStore",
);

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fromFileSystemError = (
  error: FileSystemError,
  runId?: string,
): RunStoreError =>
  new RunStoreError({
    operation: error.operation,
    path: error.path,
    message: error.message,
    ...(runId === undefined ? {} : { runId }),
  });

const validationError = (
  operation: string,
  artifactPath: string,
  error: unknown,
  runId: string,
): RunStoreError =>
  new RunStoreError({
    operation,
    path: artifactPath,
    message: errorMessage(error),
    runId,
  });

const decodeStatusEffect = (
  raw: string,
  statusPath: string,
  runId: string,
): Effect.Effect<RunStatusRecord, RunStoreError> =>
  Effect.try({
    try: () => decodeRunStatusRecordJson(raw),
    catch: (error) => validationError("readStatus", statusPath, error, runId),
  });

const decodeTransitionEffect = (
  record: RunStatusRecord,
  statusPath: string,
  runId: string,
): Effect.Effect<RunStatusRecord, RunStoreError> =>
  Effect.try({
    try: () => decodeRunStatusRecord(record),
    catch: (error) => validationError("transition", statusPath, error, runId),
  });

const invalidTransition = (
  from: RunStatus,
  to: RunStatus,
  statusPath: string,
  runId: string,
): RunStoreError =>
  new RunStoreError({
    operation: "transition",
    path: statusPath,
    message: `Invalid run status transition: ${from} -> ${to}`,
    runId,
  });

const hasInfrastructureRollbackDiagnostic = (
  record: RunStatusRecord,
): boolean =>
  record.diagnostics?.includes(INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC) === true;

const isAcceptedTransition = (
  current: RunStatusRecord,
  next: RunStatusRecord,
): boolean => {
  if (current.status === "STARTING") {
    return (
      next.status === "RUNNING" ||
      next.status === "ABORTED" ||
      (next.status === "FAILED" && hasInfrastructureRollbackDiagnostic(next))
    );
  }
  return current.status === "RUNNING" && terminalStatuses.has(next.status);
};

const makeArtifacts = (runsDirectory: string, runId: string): RunArtifacts => {
  const runDirectory = path.join(runsDirectory, runId);
  return Object.freeze({
    runId,
    runDirectory,
    manifestPath: path.join(runDirectory, "run.json"),
    taskPath: path.join(runDirectory, "task.md"),
    systemPromptPath: path.join(runDirectory, "system-prompt.md"),
    eventsPath: path.join(runDirectory, "events.jsonl"),
    stderrPath: path.join(runDirectory, "stderr.log"),
    statusPath: path.join(runDirectory, "status.json"),
  });
};

const makeSystemPrompt = (rolePrompt: string): string =>
  `${rolePrompt}\n\n${NESTED_DELEGATION_PROMPT}\n\n${STRUCTURED_COMPLETION_PROMPT}\n`;

const makeManifest = (
  task: ResolvedTask,
  artifacts: RunArtifacts,
  createdAt: string,
): RunManifest =>
  decodeRunManifest({
    runId: artifacts.runId,
    createdAt,
    task: {
      index: task.index,
      cwd: task.cwd,
    },
    agent: {
      name: task.agent.name,
      description: task.agent.description,
      model: task.agent.model,
      thinking: task.agent.thinking,
      ...(task.agent.tools === undefined ? {} : { tools: task.agent.tools }),
      writer: task.agent.writer,
      providerExtensions: task.agent.providerExtensions,
      definitionPath: task.agent.definitionPath,
    },
    artifacts,
  });

const removeTemporaryBestEffort = (
  fileSystem: FileSystemService,
  temporaryPath: string,
): Effect.Effect<void> => fileSystem.remove(temporaryPath).pipe(Effect.ignore);

const makeActiveRunStore = (
  artifacts: RunArtifacts,
  fileSystem: FileSystemService,
  ids: RunIdFactory,
): Effect.Effect<ActiveRunStore> =>
  Effect.gen(function* () {
    const statusSemaphore = yield* Effect.makeSemaphore(1);
    const mapFileError = (error: FileSystemError): RunStoreError =>
      fromFileSystemError(error, artifacts.runId);

    const readStatus = fileSystem.readTextFile(artifacts.statusPath).pipe(
      Effect.mapError(mapFileError),
      Effect.flatMap((raw) =>
        decodeStatusEffect(raw, artifacts.statusPath, artifacts.runId),
      ),
    );

    const replaceStatus = (
      record: RunStatusRecord,
    ): Effect.Effect<void, RunStoreError> =>
      Effect.gen(function* () {
        const temporaryId = yield* ids.generate;
        const temporaryPath = path.join(
          artifacts.runDirectory,
          `status.${temporaryId}.tmp`,
        );
        yield* fileSystem
          .writeTextFile(temporaryPath, json(record), { mode: FILE_MODE })
          .pipe(
            Effect.catchAll((primary) =>
              removeTemporaryBestEffort(fileSystem, temporaryPath).pipe(
                Effect.zipRight(Effect.fail(primary)),
              ),
            ),
            Effect.mapError(mapFileError),
          );
        yield* fileSystem.rename(temporaryPath, artifacts.statusPath).pipe(
          Effect.catchAll((primary) =>
            removeTemporaryBestEffort(fileSystem, temporaryPath).pipe(
              Effect.zipRight(Effect.fail(primary)),
            ),
          ),
          Effect.mapError(mapFileError),
        );
      });

    const transition = (
      candidate: RunStatusRecord,
    ): Effect.Effect<boolean, RunStoreError> =>
      decodeTransitionEffect(
        candidate,
        artifacts.statusPath,
        artifacts.runId,
      ).pipe(
        Effect.flatMap((record) =>
          statusSemaphore.withPermits(1)(
            Effect.uninterruptible(
              Effect.gen(function* () {
                const current = yield* readStatus;
                if (terminalStatuses.has(current.status)) return false;
                if (!isAcceptedTransition(current, record)) {
                  return yield* invalidTransition(
                    current.status,
                    record.status,
                    artifacts.statusPath,
                    artifacts.runId,
                  );
                }
                yield* replaceStatus(record);
                return true;
              }),
            ),
          ),
        ),
      );

    return Object.freeze({
      artifacts,
      transition,
      readStatus,
      appendEvent: (rawLine: string) =>
        fileSystem
          .appendTextFile(artifacts.eventsPath, rawLine)
          .pipe(Effect.mapError(mapFileError)),
      appendStderr: (chunk: string) =>
        fileSystem
          .appendTextFile(artifacts.stderrPath, chunk)
          .pipe(Effect.mapError(mapFileError)),
    });
  });

const makeRunStore: Effect.Effect<
  RunStore,
  never,
  FileSystemService | RunIdFactory | EnvironmentService | HomeDirectoryService
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystemService;
  const ids = yield* RunIdFactory;
  const agentDirectory = yield* resolveAgentDirectoryEffect;
  const runsDirectory = path.join(agentDirectory, "subagents", "runs");

  return Object.freeze({
    create: (task: ResolvedTask) =>
      Effect.gen(function* () {
        const createdAtMillis = yield* Clock.currentTimeMillis;
        const createdAt = DateTime.formatIso(
          DateTime.unsafeMake(createdAtMillis),
        );
        const generatedId = yield* ids.generate;
        const runId = `${createdAtMillis}-${generatedId}`;
        const artifacts = makeArtifacts(runsDirectory, runId);

        return yield* Effect.gen(function* () {
          const initialStatus = yield* Effect.try({
            try: () =>
              decodeRunStatusRecord({
                status: "STARTING",
                updatedAt: createdAt,
              }),
            catch: (error) =>
              validationError(
                "createStatus",
                artifacts.statusPath,
                error,
                runId,
              ),
          });

          yield* fileSystem.makeDirectory(artifacts.runDirectory, {
            recursive: true,
            mode: DIRECTORY_MODE,
          });
          yield* fileSystem.writeTextFile(artifacts.taskPath, task.task, {
            mode: FILE_MODE,
          });
          yield* fileSystem.writeTextFile(
            artifacts.systemPromptPath,
            makeSystemPrompt(task.agent.rolePrompt),
            { mode: FILE_MODE },
          );

          const manifest = yield* Effect.try({
            try: () => makeManifest(task, artifacts, createdAt),
            catch: (error) =>
              validationError(
                "createManifest",
                artifacts.manifestPath,
                error,
                runId,
              ),
          });
          yield* fileSystem.writeTextFile(
            artifacts.manifestPath,
            json(manifest),
            { mode: FILE_MODE },
          );
          yield* fileSystem.writeTextFile(artifacts.eventsPath, "", {
            mode: FILE_MODE,
          });
          yield* fileSystem.writeTextFile(artifacts.stderrPath, "", {
            mode: FILE_MODE,
          });
          yield* fileSystem.writeTextFile(
            artifacts.statusPath,
            json(initialStatus),
            { mode: FILE_MODE },
          );

          return yield* makeActiveRunStore(artifacts, fileSystem, ids);
        }).pipe(
          Effect.mapError((error) =>
            error instanceof RunStoreError
              ? error
              : fromFileSystemError(error, runId),
          ),
        );
      }),
  });
});

const makeLayer = (factory: RunIdFactory) =>
  Layer.effect(RunStoreTag, makeRunStore).pipe(
    Layer.provide(Layer.succeed(RunIdFactory, factory)),
  );

export const RunStore = Object.assign(RunStoreTag, {
  layer: makeLayer,
  Live: makeLayer({ generate: Effect.sync(randomUUID) }),
});
