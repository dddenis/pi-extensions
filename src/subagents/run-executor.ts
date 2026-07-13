import { fileURLToPath } from "node:url";
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
  Stream,
} from "effect";
import { EnvironmentService } from "../services/environment";
import {
  type ProcessError,
  type ProcessExit,
  type ProcessShutdownPolicy,
  type ProcessShutdownReport,
  ProcessService,
} from "../services/process";
import {
  buildChildInvocation,
  type ChildExecutableSelector,
} from "./child-command";
import { ChildProcessError, RunStoreError, type SubagentError } from "./errors";
import { makePiEventAccumulator, type PiEventFinalization } from "./pi-events";
import type { ResolvedTask } from "./preflight";
import { makeChildProgress, type ChildProgress } from "./progress";
import {
  INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
  type ActiveRunStore,
} from "./run-store";
import {
  COMPLETION_SUMMARY_MAX_CODE_POINTS,
  type RunResult,
  type RunStatusRecord,
  type RunUsage,
  type TerminalStatus,
} from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";

export interface RunHandle {
  readonly launched: Effect.Effect<void, SubagentError>;
  readonly awaitResult: Effect.Effect<RunResult, SubagentError>;
}

export interface RunExecutor {
  readonly launch: (
    task: ResolvedTask,
    run: ActiveRunStore,
    onProgress: (progress: ChildProgress) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<RunHandle, SubagentError, Scope.Scope>;
}

export interface RunExecutorConfig {
  readonly completionEntrypoint: string;
  readonly executableSelector?: ChildExecutableSelector;
  readonly shutdownPolicy?: ProcessShutdownPolicy;
  readonly postExitDrainTimeout?: Duration.DurationInput;
}

const RunExecutorTag = Context.GenericTag<RunExecutor>(
  "pi-extensions/subagents/RunExecutor",
);

const defaultShutdownPolicy: ProcessShutdownPolicy = {
  stdinCloseTimeout: 100,
  gracefulTimeout: 1_000,
  forcedTimeout: 1_000,
  totalTimeout: 2_100,
};

const defaultPostExitDrainTimeout = Duration.seconds(1);
const truncatedOutputDiagnostic =
  "Process output did not drain after exit; retained evidence may be truncated";

const emptyUsage = (): RunUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
});

const timestamp: Effect.Effect<string> = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.unsafeMake(millis))),
);

const diagnosticText = (value: string): string => {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length === 0 ? "Subagent run failed" : singleLine;
};

const concise = (value: string): string =>
  Array.from(diagnosticText(sanitizeTerminalText(value)))
    .slice(0, COMPLETION_SUMMARY_MAX_CODE_POINTS)
    .join("");

const processFailure = (
  error: ProcessError,
  task: ResolvedTask,
  run: ActiveRunStore,
): ChildProcessError =>
  new ChildProcessError({
    operation: error.operation,
    message: error.message,
    runId: run.artifacts.runId,
    agent: task.agent.name,
  });

const diagnosticFor = (error: RunStoreError | ChildProcessError): string =>
  diagnosticText(`${error._tag} ${error.operation}: ${error.message}`);

const shutdownDiagnostics = (
  report: ProcessShutdownReport,
): ReadonlyArray<string> => {
  const diagnostics: Array<string> = [];
  for (const error of report.processErrors) {
    diagnostics.push(
      diagnosticText(`ProcessError ${error.operation}: ${error.message}`),
    );
  }
  for (const error of report.signalErrors) {
    if (
      !report.processErrors.some(
        (processError) =>
          processError.operation === error.operation &&
          processError.message === error.message,
      )
    ) {
      diagnostics.push(
        diagnosticText(`ProcessError ${error.operation}: ${error.message}`),
      );
    }
  }
  if (report.stdin._tag === "Failed") {
    diagnostics.push(
      diagnosticText(
        `ProcessError ${report.stdin.error.operation}: ${report.stdin.error.message}`,
      ),
    );
  } else if (report.stdin._tag === "TimedOut") {
    diagnostics.push("Process stdin cleanup timed out");
  }
  if (report.terminal?._tag === "Failed") {
    diagnostics.push(
      diagnosticText(
        `ProcessError ${report.terminal.error.operation}: ${report.terminal.error.message}`,
      ),
    );
  }
  if (report.terminalUnconfirmed) {
    diagnostics.push("Process cleanup could not confirm terminal exit");
  }
  if (report.deadlineExceeded) {
    diagnostics.push("Process cleanup exceeded its deadline");
  }
  if (report.internalFailure !== undefined) {
    diagnostics.push(
      diagnosticText(`Process cleanup failed: ${report.internalFailure}`),
    );
  }
  return Object.freeze([...new Set(diagnostics)]);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const progressCauseDiagnostic = (
  cause: Cause.Cause<unknown>,
): string | undefined => {
  if (Cause.isInterruptedOnly(cause)) return undefined;
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    return diagnosticText(
      `Progress callback failed: ${errorMessage(failure.value)}`,
    );
  }
  const defect = Cause.dieOption(cause);
  return Option.isSome(defect)
    ? diagnosticText(`Progress callback defect: ${errorMessage(defect.value)}`)
    : "Progress callback failed";
};

interface TerminalCandidate {
  readonly record: RunStatusRecord;
  readonly result: RunResult;
}

const withDiagnostics = (
  candidate: TerminalCandidate,
  diagnostics: ReadonlyArray<string>,
): TerminalCandidate =>
  diagnostics.length === 0
    ? candidate
    : {
        record: {
          ...candidate.record,
          diagnostics: [
            ...(candidate.record.diagnostics ?? []),
            ...diagnostics,
          ],
        },
        result: {
          ...candidate.result,
          diagnostics: [...candidate.result.diagnostics, ...diagnostics],
        },
      };

const makeResult = (
  task: ResolvedTask,
  run: ActiveRunStore,
  status: TerminalStatus,
  summary: string,
  exit: ProcessExit,
  usage: RunUsage,
  diagnostics: ReadonlyArray<string>,
  reportPath?: string,
): RunResult => ({
  runId: run.artifacts.runId,
  agent: task.agent.name,
  status,
  summary,
  ...(reportPath === undefined ? {} : { reportPath }),
  exitCode: exit.code,
  signal: exit.signal,
  usage: { ...usage },
  artifacts: run.artifacts,
  diagnostics: [...diagnostics],
});

const failedCandidate = (
  task: ResolvedTask,
  run: ActiveRunStore,
  reason: string,
  exit: ProcessExit,
  usage: RunUsage,
  infrastructureRollback = false,
): Effect.Effect<TerminalCandidate> =>
  timestamp.pipe(
    Effect.map((updatedAt) => {
      const diagnostic = diagnosticText(reason);
      const summary = concise(diagnostic);
      const diagnostics = infrastructureRollback
        ? [diagnostic, INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC]
        : [diagnostic];
      return {
        record: {
          status: "FAILED",
          updatedAt,
          summary,
          diagnostics,
        },
        result: makeResult(
          task,
          run,
          "FAILED",
          summary,
          exit,
          usage,
          diagnostics,
        ),
      };
    }),
  );

const finalizationCandidate = (
  task: ResolvedTask,
  run: ActiveRunStore,
  finalization: PiEventFinalization,
  exit: ProcessExit,
  diagnostics: ReadonlyArray<string>,
): Effect.Effect<TerminalCandidate> =>
  finalization.status === "failed"
    ? failedCandidate(
        task,
        run,
        finalization.reason,
        exit,
        finalization.usage,
      ).pipe(Effect.map((candidate) => withDiagnostics(candidate, diagnostics)))
    : timestamp.pipe(
        Effect.map((updatedAt) => ({
          record: {
            status: finalization.completion.status,
            updatedAt,
            summary: finalization.completion.summary,
            ...(finalization.completion.reportPath === undefined
              ? {}
              : { reportPath: finalization.completion.reportPath }),
            ...(diagnostics.length === 0 ? {} : { diagnostics }),
          },
          result: makeResult(
            task,
            run,
            finalization.completion.status,
            finalization.completion.summary,
            exit,
            finalization.usage,
            diagnostics,
            finalization.completion.reportPath,
          ),
        })),
      );

const durableResult = (
  task: ResolvedTask,
  run: ActiveRunStore,
  fallback: RunResult,
): Effect.Effect<RunResult, RunStoreError> =>
  run.readStatus.pipe(
    Effect.flatMap((record) => {
      if (record.status === "STARTING" || record.status === "RUNNING") {
        return Effect.fail(
          new RunStoreError({
            operation: "transition",
            path: run.artifacts.statusPath,
            runId: run.artifacts.runId,
            message: "Terminal transition was not committed",
          }),
        );
      }
      const summary = record.summary ?? fallback.summary;
      return Effect.succeed(
        makeResult(
          task,
          run,
          record.status,
          summary,
          { code: fallback.exitCode, signal: fallback.signal },
          fallback.usage,
          record.diagnostics ?? fallback.diagnostics,
          record.reportPath,
        ),
      );
    }),
  );

const commitCandidate = (
  task: ResolvedTask,
  run: ActiveRunStore,
  candidate: TerminalCandidate,
): Effect.Effect<RunResult, RunStoreError> =>
  run.transition(candidate.record).pipe(
    Effect.matchEffect({
      onSuccess: (committed) =>
        committed
          ? Effect.succeed(candidate.result)
          : durableResult(task, run, candidate.result),
      onFailure: (storeError) =>
        failedCandidate(
          task,
          run,
          diagnosticFor(storeError),
          {
            code: candidate.result.exitCode,
            signal: candidate.result.signal,
          },
          candidate.result.usage,
          candidate.record.diagnostics?.includes(
            INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
          ) === true,
        ).pipe(
          Effect.map((fallback) =>
            withDiagnostics(
              fallback,
              candidate.result.diagnostics.filter(
                (diagnostic) =>
                  diagnostic !== INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
              ),
            ),
          ),
          Effect.flatMap((fallback) =>
            run
              .transition(fallback.record)
              .pipe(
                Effect.flatMap((committed) =>
                  committed
                    ? Effect.succeed(fallback.result)
                    : durableResult(task, run, fallback.result),
                ),
              ),
          ),
        ),
    }),
  );

const abort = (run: ActiveRunStore): Effect.Effect<void> =>
  timestamp.pipe(
    Effect.flatMap((updatedAt) =>
      run.transition({
        status: "ABORTED",
        updatedAt,
        summary: "Parent cancelled subagent run",
      }),
    ),
    Effect.catchAll((error) =>
      run
        .appendStderr(`Unable to record ABORTED: ${diagnosticFor(error)}\n`)
        .pipe(Effect.ignore),
    ),
    Effect.asVoid,
  );

const makeRunExecutor = Effect.gen(function* () {
  const processes = yield* ProcessService;
  const environment = yield* EnvironmentService;

  const service = (config: RunExecutorConfig): RunExecutor => ({
    launch: (task, run, onProgress) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const parentEnv = yield* environment.snapshot;
          const invocation = buildChildInvocation(
            {
              task,
              artifacts: run.artifacts,
              parentEnv,
              completionEntrypoint: config.completionEntrypoint,
            },
            config.executableSelector,
          );
          const processScope = yield* Scope.make();
          yield* Effect.addFinalizer(() =>
            Scope.close(processScope, Exit.void),
          );
          const managedOutcome = yield* Effect.either(
            Scope.extend(
              processes.spawnScoped(
                invocation.command,
                invocation.args,
                {
                  cwd: invocation.cwd,
                  env: invocation.env,
                  stdio: "pipe",
                },
                config.shutdownPolicy ?? defaultShutdownPolicy,
              ),
              processScope,
            ).pipe(
              Effect.mapError((error) => processFailure(error, task, run)),
            ),
          );
          if (Either.isLeft(managedOutcome)) {
            yield* Scope.close(processScope, Exit.void);
            const candidate = yield* failedCandidate(
              task,
              run,
              diagnosticFor(managedOutcome.left),
              { code: null, signal: null },
              emptyUsage(),
              true,
            );
            const recorded = yield* Effect.either(
              commitCandidate(task, run, candidate),
            );
            if (Either.isLeft(recorded)) return yield* recorded.left;
            return yield* managedOutcome.left;
          }
          const managed = managedOutcome.right;
          const accumulator = makePiEventAccumulator();
          const progress = makeChildProgress(
            run.artifacts.runId,
            task.agent.name,
          );
          const launched = yield* Deferred.make<void, SubagentError>();
          const terminalGate = yield* Deferred.make<void>();
          const firstStoreFailure = yield* Ref.make<
            Option.Option<RunStoreError>
          >(Option.none());
          const firstStreamFailure = yield* Deferred.make<ProcessError>();
          const firstProgressDiagnostic = yield* Ref.make<
            Option.Option<string>
          >(Option.none());
          const progressActive = yield* Ref.make(false);

          const captureStoreFailure = (
            error: RunStoreError,
          ): Effect.Effect<void> =>
            Ref.update(firstStoreFailure, (current) =>
              Option.isSome(current) ? current : Option.some(error),
            );
          const captureProgressCause = (
            cause: Cause.Cause<unknown>,
          ): Effect.Effect<void> => {
            const diagnostic = progressCauseDiagnostic(cause);
            return diagnostic === undefined
              ? Effect.void
              : Ref.update(firstProgressDiagnostic, (current) =>
                  Option.isSome(current) ? current : Option.some(diagnostic),
                );
          };
          const deliverProgress = (
            snapshot: ChildProgress,
          ): Effect.Effect<void> =>
            Ref.modify(progressActive, (active) =>
              active ? [false, true] : [true, true],
            ).pipe(
              Effect.flatMap((start) =>
                start
                  ? Effect.forkIn(
                      Effect.suspend(() => onProgress(snapshot)).pipe(
                        Effect.catchAllCause(captureProgressCause),
                        Effect.ensuring(Ref.set(progressActive, false)),
                      ),
                      processScope,
                    ).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            );

          const captureStreamFailure = (
            error: ProcessError,
          ): Effect.Effect<void> =>
            Deferred.succeed(firstStreamFailure, error).pipe(Effect.asVoid);
          const stdout = Stream.runForEach(managed.stdoutLines, (line) =>
            run.appendEvent(`${line}\n`).pipe(
              Effect.catchAll(captureStoreFailure),
              Effect.zipRight(
                accumulator.consume(line).pipe(
                  Effect.matchEffect({
                    onFailure: () => Effect.void,
                    onSuccess: (event) =>
                      progress
                        .update(event)
                        .pipe(
                          Effect.zipRight(deliverProgress(progress.snapshot)),
                        ),
                  }),
                ),
              ),
            ),
          ).pipe(Effect.tapError(captureStreamFailure));
          const stderr = Stream.runForEach(managed.stderrChunks, (chunk) =>
            run
              .appendStderr(chunk)
              .pipe(Effect.catchAll(captureStoreFailure), Effect.asVoid),
          ).pipe(Effect.tapError(captureStreamFailure));
          const stdoutFiber = yield* restore(
            Effect.forkIn(stdout, processScope),
          );
          const stderrFiber = yield* restore(
            Effect.forkIn(stderr, processScope),
          );
          const stdinRequest = yield* Effect.either(managed.requestStdinEnd);

          const commitTerminal = (
            candidate: TerminalCandidate,
          ): Effect.Effect<RunResult, RunStoreError> =>
            Deferred.await(terminalGate).pipe(
              Effect.zipRight(commitCandidate(task, run, candidate)),
            );

          const execution: Effect.Effect<RunResult, SubagentError> = Effect.gen(
            function* () {
              const launchOutcome = yield* Effect.either(managed.awaitLaunch);
              if (Either.isLeft(launchOutcome)) {
                const error = processFailure(launchOutcome.left, task, run);
                yield* Scope.close(processScope, Exit.void);
                const candidate = yield* failedCandidate(
                  task,
                  run,
                  diagnosticFor(error),
                  { code: null, signal: null },
                  emptyUsage(),
                  true,
                );
                const result = yield* Effect.either(
                  commitCandidate(task, run, candidate),
                );
                yield* Deferred.fail(launched, error).pipe(Effect.asVoid);
                if (Either.isLeft(result)) return yield* result.left;
                return result.right;
              }

              const runningRecord: RunStatusRecord = {
                status: "RUNNING",
                updatedAt: yield* timestamp,
              };
              const running = yield* Effect.either(
                run.transition(runningRecord),
              );
              if (Either.isLeft(running)) {
                yield* Scope.close(processScope, Exit.void);
                const candidate = yield* failedCandidate(
                  task,
                  run,
                  diagnosticFor(running.left),
                  { code: null, signal: null },
                  emptyUsage(),
                  true,
                );
                const result = yield* Effect.either(
                  commitCandidate(task, run, candidate),
                );
                yield* Deferred.fail(launched, running.left).pipe(
                  Effect.asVoid,
                );
                if (Either.isLeft(result)) return yield* result.left;
                return result.right;
              }
              if (!running.right) {
                const error = new RunStoreError({
                  operation: "transition",
                  path: run.artifacts.statusPath,
                  runId: run.artifacts.runId,
                  message: "RUNNING transition lost terminal ownership",
                });
                const result = yield* Effect.either(
                  durableResult(
                    task,
                    run,
                    makeResult(
                      task,
                      run,
                      "FAILED",
                      error.message,
                      { code: null, signal: null },
                      emptyUsage(),
                      [diagnosticFor(error)],
                    ),
                  ),
                );
                yield* Deferred.fail(launched, error).pipe(Effect.asVoid);
                if (Either.isLeft(result)) return yield* result.left;
                return result.right;
              }
              yield* progress.setLifecycle("RUNNING");
              yield* Deferred.succeed(launched, undefined).pipe(Effect.asVoid);
              yield* deliverProgress(progress.snapshot);

              if (Either.isLeft(stdinRequest)) {
                const error = processFailure(stdinRequest.left, task, run);
                const report = yield* managed.shutdown;
                yield* Scope.close(processScope, Exit.void);
                const snapshot = yield* accumulator.snapshot;
                const progressDiagnostic = yield* Ref.get(
                  firstProgressDiagnostic,
                );
                const candidate = withDiagnostics(
                  yield* failedCandidate(
                    task,
                    run,
                    diagnosticFor(error),
                    { code: null, signal: null },
                    snapshot.usage,
                  ),
                  [
                    ...(Option.isSome(progressDiagnostic)
                      ? [progressDiagnostic.value]
                      : []),
                    ...shutdownDiagnostics(report),
                  ],
                );
                return yield* commitTerminal(candidate);
              }

              const processCompletion = yield* Effect.raceFirst(
                Effect.either(managed.waitForExit).pipe(
                  Effect.map((outcome) => ({ _tag: "Exit", outcome }) as const),
                ),
                Deferred.await(firstStreamFailure).pipe(
                  Effect.map(
                    (error) => ({ _tag: "StreamFailed", error }) as const,
                  ),
                ),
              );
              if (processCompletion._tag === "StreamFailed") {
                const report = yield* managed.shutdown;
                yield* Scope.close(processScope, Exit.void);
                const snapshot = yield* accumulator.snapshot;
                const storeFailure = yield* Ref.get(firstStoreFailure);
                const progressDiagnostic = yield* Ref.get(
                  firstProgressDiagnostic,
                );
                const failure = Option.getOrElse(storeFailure, () =>
                  processFailure(processCompletion.error, task, run),
                );
                const terminalExit =
                  report.terminal?._tag === "Exited"
                    ? report.terminal.exit
                    : { code: null, signal: null };
                const candidate = withDiagnostics(
                  yield* failedCandidate(
                    task,
                    run,
                    diagnosticFor(failure),
                    terminalExit,
                    snapshot.usage,
                  ),
                  [
                    ...(Option.isSome(progressDiagnostic)
                      ? [progressDiagnostic.value]
                      : []),
                    ...shutdownDiagnostics(report),
                  ],
                );
                return yield* commitTerminal(candidate);
              }
              const exitOutcome = processCompletion.outcome;
              const drainOutcome = yield* Effect.all(
                [
                  Effect.either(Fiber.join(stdoutFiber)),
                  Effect.either(Fiber.join(stderrFiber)),
                ] as const,
                { concurrency: "unbounded" },
              ).pipe(
                Effect.timeoutOption(
                  config.postExitDrainTimeout ?? defaultPostExitDrainTimeout,
                ),
              );
              const outputTruncated = Option.isNone(drainOutcome);
              if (outputTruncated) {
                yield* managed.closeOutput;
                yield* Effect.all(
                  [Fiber.interrupt(stdoutFiber), Fiber.interrupt(stderrFiber)],
                  { concurrency: "unbounded" },
                );
              }
              const [stdoutOutcome, stderrOutcome] = Option.isSome(drainOutcome)
                ? drainOutcome.value
                : [Either.right(undefined), Either.right(undefined)];
              const report = yield* managed.shutdown;
              yield* Scope.close(processScope, Exit.void);
              const processDiagnostics = shutdownDiagnostics(report);
              const storeFailure = yield* Ref.get(firstStoreFailure);
              const progressDiagnostic = yield* Ref.get(
                firstProgressDiagnostic,
              );
              const progressDiagnostics = Option.isSome(progressDiagnostic)
                ? [progressDiagnostic.value]
                : [];
              const secondaryDiagnostics = [
                ...progressDiagnostics,
                ...(outputTruncated ? [truncatedOutputDiagnostic] : []),
                ...processDiagnostics,
              ];

              if (Option.isSome(storeFailure)) {
                const snapshot = yield* accumulator.snapshot;
                const exit = Either.isRight(exitOutcome)
                  ? exitOutcome.right
                  : { code: null, signal: null };
                const candidate = withDiagnostics(
                  yield* failedCandidate(
                    task,
                    run,
                    diagnosticFor(storeFailure.value),
                    exit,
                    snapshot.usage,
                  ),
                  secondaryDiagnostics,
                );
                return yield* commitTerminal(candidate);
              }

              const streamError = Either.isLeft(stdoutOutcome)
                ? stdoutOutcome.left
                : Either.isLeft(stderrOutcome)
                  ? stderrOutcome.left
                  : undefined;
              if (streamError !== undefined) {
                const error = processFailure(streamError, task, run);
                const snapshot = yield* accumulator.snapshot;
                const exit = Either.isRight(exitOutcome)
                  ? exitOutcome.right
                  : { code: null, signal: null };
                const candidate = withDiagnostics(
                  yield* failedCandidate(
                    task,
                    run,
                    diagnosticFor(error),
                    exit,
                    snapshot.usage,
                  ),
                  secondaryDiagnostics,
                );
                return yield* commitTerminal(candidate);
              }
              if (Either.isLeft(exitOutcome)) {
                const error = processFailure(exitOutcome.left, task, run);
                const snapshot = yield* accumulator.snapshot;
                const candidate = withDiagnostics(
                  yield* failedCandidate(
                    task,
                    run,
                    diagnosticFor(error),
                    { code: null, signal: null },
                    snapshot.usage,
                  ),
                  secondaryDiagnostics,
                );
                return yield* commitTerminal(candidate);
              }

              if (outputTruncated) {
                const snapshot = yield* accumulator.snapshot;
                const candidate = withDiagnostics(
                  yield* failedCandidate(
                    task,
                    run,
                    truncatedOutputDiagnostic,
                    exitOutcome.right,
                    snapshot.usage,
                  ),
                  [...progressDiagnostics, ...processDiagnostics],
                );
                return yield* commitTerminal(candidate);
              }

              if (processDiagnostics.length > 0) {
                const snapshot = yield* accumulator.snapshot;
                const firstDiagnostic = processDiagnostics[0];
                if (firstDiagnostic === undefined) {
                  return yield* Effect.die("missing process diagnostic");
                }
                const candidate = withDiagnostics(
                  yield* failedCandidate(
                    task,
                    run,
                    firstDiagnostic,
                    exitOutcome.right,
                    snapshot.usage,
                  ),
                  [...progressDiagnostics, ...processDiagnostics.slice(1)],
                );
                return yield* commitTerminal(candidate);
              }

              const finalization = yield* accumulator.finalize(
                exitOutcome.right,
              );
              const candidate = yield* finalizationCandidate(
                task,
                run,
                finalization,
                exitOutcome.right,
                progressDiagnostics,
              );
              return yield* commitTerminal(candidate);
            },
          ).pipe(
            Effect.onInterrupt(() =>
              Scope.close(processScope, Exit.void).pipe(
                Effect.zipRight(abort(run)),
                Effect.zipRight(
                  Deferred.fail(
                    launched,
                    new ChildProcessError({
                      operation: "wait",
                      message: "Subagent run was interrupted",
                      runId: run.artifacts.runId,
                      agent: task.agent.name,
                    }),
                  ).pipe(Effect.ignore),
                ),
              ),
            ),
          );
          const executionFiber = yield* restore(Effect.forkScoped(execution));

          return Object.freeze({
            launched: Deferred.await(launched),
            awaitResult: Deferred.succeed(terminalGate, undefined).pipe(
              Effect.zipRight(Fiber.join(executionFiber)),
            ),
          });
        }),
      ),
  });

  return { service };
});

const layer = (config: RunExecutorConfig) =>
  Layer.effect(
    RunExecutorTag,
    makeRunExecutor.pipe(Effect.map(({ service }) => service(config))),
  );

const liveCompletionEntrypoint = fileURLToPath(
  new URL("./index.ts", import.meta.url),
);

export const RunExecutor = Object.assign(RunExecutorTag, {
  layer,
  Live: layer({ completionEntrypoint: liveCompletionEntrypoint }),
});
