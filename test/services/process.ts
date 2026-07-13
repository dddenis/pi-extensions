import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Either,
  Fiber,
  Layer,
  Mailbox,
  Option,
  Ref,
  Stream,
} from "effect";
import {
  type ManagedProcess,
  ProcessError,
  ProcessService,
  type ProcessExit,
  type ProcessShutdownPolicy,
  type SpawnedProcess,
  type SpawnProcessOptions,
} from "../../src/services/process";

export interface ProcessServiceTestConfig {
  readonly stdinEnd?: "complete" | "never";
  readonly manualLaunch?: boolean;
}

export interface ProcessServiceTestCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnProcessOptions;
}

export interface ProcessServiceTestProcessState {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnProcessOptions;
  readonly stdinWrites: ReadonlyArray<string>;
  readonly stdinEndCount: number;
  readonly signals: ReadonlyArray<"SIGTERM" | "SIGKILL">;
  readonly lifecycleEvents: ReadonlyArray<string>;
  readonly outputCloseCount: number;
  readonly unrefCount: number;
}

export interface ProcessServiceTestState {
  readonly calls: ReadonlyArray<ProcessServiceTestCall>;
  readonly managedSpawnCount: number;
  readonly detachedSpawnCount: number;
  readonly stdinWrites: ReadonlyArray<string>;
  readonly stdinEndCount: number;
  readonly signals: ReadonlyArray<"SIGTERM" | "SIGKILL">;
  readonly lifecycleEvents: ReadonlyArray<string>;
  readonly outputCloseCount: number;
  readonly unrefCount: number;
  readonly processes: ReadonlyArray<ProcessServiceTestProcessState>;
}

export interface ProcessServiceTestService {
  readonly emitLaunch: (index: number) => Effect.Effect<void>;
  readonly emitLaunchFailure: (
    index: number,
    error: ProcessError,
  ) => Effect.Effect<void>;
  readonly emitStdout: (index: number, line: string) => Effect.Effect<void>;
  readonly emitStdoutFailure: (
    index: number,
    error: ProcessError,
  ) => Effect.Effect<void>;
  readonly emitStderr: (index: number, chunk: string) => Effect.Effect<void>;
  readonly emitExit: (index: number, exit: ProcessExit) => Effect.Effect<void>;
  readonly emitOutputEnd: (index: number) => Effect.Effect<void>;
  readonly complete: (index: number, exit: ProcessExit) => Effect.Effect<void>;
  readonly emitError: (
    index: number,
    error: ProcessError,
  ) => Effect.Effect<void>;
  readonly emitPostLaunchError: (
    index: number,
    error: ProcessError,
  ) => Effect.Effect<void>;
  readonly getState: Effect.Effect<ProcessServiceTestState>;
  readonly resetCalls: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

type ProcessEventMailbox = Mailbox.Mailbox<string, ProcessError>;
type TestSpawnedProcess = SpawnedProcess &
  Pick<
    ManagedProcess,
    "awaitLaunch" | "closeOutput" | "requestStdinEnd" | "awaitStdinEnd"
  > & {
    readonly index: number;
    readonly exit: Deferred.Deferred<ProcessExit, ProcessError>;
    readonly stdinAvailable: boolean;
  };

interface ProcessServiceTestInternalProcessState extends ProcessServiceTestProcessState {
  readonly index: number;
  readonly launch: Deferred.Deferred<void, ProcessError>;
  readonly exit: Deferred.Deferred<ProcessExit, ProcessError>;
  readonly stdout: ProcessEventMailbox;
  readonly stderr: ProcessEventMailbox;
  readonly processErrors: ReadonlyArray<ProcessError>;
}

interface ProcessServiceTestInternalState extends Omit<
  ProcessServiceTestState,
  "processes"
> {
  readonly processes: ReadonlyArray<ProcessServiceTestInternalProcessState>;
}

type ProcessServiceTestRef = Ref.Ref<ProcessServiceTestInternalState>;

const initialState = (): ProcessServiceTestInternalState => ({
  calls: [],
  managedSpawnCount: 0,
  detachedSpawnCount: 0,
  stdinWrites: [],
  stdinEndCount: 0,
  signals: [],
  lifecycleEvents: [],
  outputCloseCount: 0,
  unrefCount: 0,
  processes: [],
});

const copyOptions = (options: SpawnProcessOptions): SpawnProcessOptions => ({
  ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options.env === undefined ? {} : { env: { ...options.env } }),
  ...(options.detached === undefined ? {} : { detached: options.detached }),
  ...(options.stdoutLineLimitBytes === undefined
    ? {}
    : { stdoutLineLimitBytes: options.stdoutLineLimitBytes }),
  stdio: options.stdio,
});

const copyCall = (call: ProcessServiceTestCall): ProcessServiceTestCall => ({
  command: call.command,
  args: [...call.args],
  options: copyOptions(call.options),
});

const copyProcess = (
  process: ProcessServiceTestInternalProcessState,
): ProcessServiceTestProcessState => ({
  command: process.command,
  args: [...process.args],
  options: copyOptions(process.options),
  stdinWrites: [...process.stdinWrites],
  stdinEndCount: process.stdinEndCount,
  signals: [...process.signals],
  lifecycleEvents: [...process.lifecycleEvents],
  outputCloseCount: process.outputCloseCount,
  unrefCount: process.unrefCount,
});

const snapshotState = (
  ref: ProcessServiceTestRef,
): Effect.Effect<ProcessServiceTestState> =>
  Ref.get(ref).pipe(
    Effect.map((state) => ({
      calls: state.calls.map(copyCall),
      managedSpawnCount: state.managedSpawnCount,
      detachedSpawnCount: state.detachedSpawnCount,
      stdinWrites: [...state.stdinWrites],
      stdinEndCount: state.stdinEndCount,
      signals: [...state.signals],
      lifecycleEvents: [...state.lifecycleEvents],
      outputCloseCount: state.outputCloseCount,
      unrefCount: state.unrefCount,
      processes: state.processes.map(copyProcess),
    })),
  );

const updateProcessAt = (
  state: ProcessServiceTestInternalState,
  index: number,
  update: (
    process: ProcessServiceTestInternalProcessState,
  ) => ProcessServiceTestInternalProcessState,
): ReadonlyArray<ProcessServiceTestInternalProcessState> =>
  state.processes.map((process, processIndex) =>
    processIndex === index ? update(process) : process,
  );

const processAtIndex = (
  ref: ProcessServiceTestRef,
  index: number,
  operation: string,
): Effect.Effect<ProcessServiceTestInternalProcessState> =>
  Ref.get(ref).pipe(
    Effect.flatMap((state) => {
      const process = state.processes[index];
      return process === undefined
        ? Effect.die(
            new Error(
              `ProcessServiceTest.${operation} requires a spawned process at index ${index}`,
            ),
          )
        : Effect.succeed(process);
    }),
  );

const copyError = (error: ProcessError): ProcessError =>
  new ProcessError({
    operation: error.operation,
    message: error.message,
    ...(error.reason === undefined ? {} : { reason: error.reason }),
    ...(error.stream === undefined ? {} : { stream: error.stream }),
    ...(error.limitBytes === undefined ? {} : { limitBytes: error.limitBytes }),
    ...(error.observedBytes === undefined
      ? {}
      : { observedBytes: error.observedBytes }),
  });

const makeProcessService = (
  ref: ProcessServiceTestRef,
  config: ProcessServiceTestConfig,
): ProcessService => {
  const spawnProcess = (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnProcessOptions,
  ): Effect.Effect<TestSpawnedProcess> =>
    Effect.gen(function* () {
      const launch = yield* Deferred.make<void, ProcessError>();
      const exit = yield* Deferred.make<ProcessExit, ProcessError>();
      const stdinEnd = yield* Deferred.make<void>();
      const stdinEndRequested = yield* Ref.make(false);
      const outputClosed = yield* Ref.make(false);
      const stdout = yield* Mailbox.make<string, ProcessError>();
      const stderr = yield* Mailbox.make<string, ProcessError>();
      const index = yield* Ref.modify(ref, (state) => {
        const process = {
          index: state.processes.length,
          command,
          args: [...args],
          options: copyOptions(options),
          stdinWrites: [],
          stdinEndCount: 0,
          signals: [],
          lifecycleEvents: [],
          outputCloseCount: 0,
          unrefCount: 0,
          launch,
          exit,
          stdout,
          stderr,
          processErrors: [],
        } satisfies ProcessServiceTestInternalProcessState;
        return [
          state.processes.length,
          {
            ...state,
            calls: [
              ...state.calls,
              {
                command,
                args: [...args],
                options: copyOptions(options),
              },
            ],
            processes: [...state.processes, process],
          },
        ] as const;
      });

      if (config.manualLaunch !== true) {
        yield* Deferred.succeed(launch, undefined).pipe(Effect.asVoid);
      }

      const stdinUnavailable = new ProcessError({
        operation: "stdin",
        message:
          "stdin is unavailable for a process spawned with ignored stdio",
      });
      const requestStdinEnd =
        options.stdio === "ignore"
          ? Effect.fail(stdinUnavailable)
          : Ref.getAndSet(stdinEndRequested, true).pipe(
              Effect.flatMap((alreadyRequested) =>
                alreadyRequested
                  ? Effect.void
                  : Ref.update(ref, (state) => ({
                      ...state,
                      stdinEndCount: state.stdinEndCount + 1,
                      lifecycleEvents: [
                        ...state.lifecycleEvents,
                        "shutdown-started",
                      ],
                      processes: updateProcessAt(state, index, (process) => ({
                        ...process,
                        stdinEndCount: process.stdinEndCount + 1,
                        lifecycleEvents: [
                          ...process.lifecycleEvents,
                          "shutdown-started",
                        ],
                      })),
                    })).pipe(
                      Effect.zipRight(
                        config.stdinEnd === "never"
                          ? Effect.void
                          : Deferred.succeed(stdinEnd, undefined).pipe(
                              Effect.asVoid,
                            ),
                      ),
                    ),
              ),
            );
      const awaitStdinEnd =
        options.stdio === "ignore"
          ? Effect.fail(stdinUnavailable)
          : Deferred.await(stdinEnd);
      const waitForExit = Deferred.await(exit);

      return {
        index,
        exit,
        awaitLaunch: Deferred.await(launch),
        stdinAvailable: options.stdio !== "ignore",
        closeOutput: Ref.getAndSet(outputClosed, true).pipe(
          Effect.flatMap((alreadyClosed) =>
            alreadyClosed
              ? Effect.void
              : Ref.update(ref, (state) => ({
                  ...state,
                  outputCloseCount: state.outputCloseCount + 1,
                  lifecycleEvents: [...state.lifecycleEvents, "output-closed"],
                  processes: updateProcessAt(state, index, (process) => ({
                    ...process,
                    outputCloseCount: process.outputCloseCount + 1,
                    lifecycleEvents: [
                      ...process.lifecycleEvents,
                      "output-closed",
                    ],
                  })),
                })).pipe(
                  Effect.zipRight(stdout.end),
                  Effect.zipRight(stderr.end),
                  Effect.asVoid,
                ),
          ),
        ),
        writeStdin:
          options.stdio === "ignore"
            ? () => Effect.fail(stdinUnavailable)
            : (value) =>
                Ref.update(ref, (state) => ({
                  ...state,
                  stdinWrites: [...state.stdinWrites, value],
                  processes: updateProcessAt(state, index, (process) => ({
                    ...process,
                    stdinWrites: [...process.stdinWrites, value],
                  })),
                })),
        requestStdinEnd,
        awaitStdinEnd,
        endStdin: requestStdinEnd.pipe(Effect.zipRight(awaitStdinEnd)),
        stdoutLines: Mailbox.toStream(stdout).pipe(
          Stream.ensuring(
            Ref.update(ref, (state) => ({
              ...state,
              lifecycleEvents: [...state.lifecycleEvents, "stdout-stopped"],
              processes: updateProcessAt(state, index, (process) => ({
                ...process,
                lifecycleEvents: [...process.lifecycleEvents, "stdout-stopped"],
              })),
            })),
          ),
        ),
        stderrChunks: Mailbox.toStream(stderr).pipe(
          Stream.ensuring(
            Ref.update(ref, (state) => ({
              ...state,
              lifecycleEvents: [...state.lifecycleEvents, "stderr-stopped"],
              processes: updateProcessAt(state, index, (process) => ({
                ...process,
                lifecycleEvents: [...process.lifecycleEvents, "stderr-stopped"],
              })),
            })),
          ),
        ),
        waitForExit,
        kill: (signal) =>
          Ref.update(ref, (state) => ({
            ...state,
            signals: [...state.signals, signal],
            processes: updateProcessAt(state, index, (process) => ({
              ...process,
              signals: [...process.signals, signal],
            })),
          })),
        unref: Ref.update(ref, (state) => ({
          ...state,
          unrefCount: state.unrefCount + 1,
          processes: updateProcessAt(state, index, (process) => ({
            ...process,
            unrefCount: process.unrefCount + 1,
          })),
        })),
      } satisfies TestSpawnedProcess;
    });

  const managed = (
    child: TestSpawnedProcess,
    policy: ProcessShutdownPolicy,
  ): Effect.Effect<ManagedProcess> => {
    const durationMillis = (input: Duration.DurationInput): number =>
      Math.max(0, Duration.toMillis(Duration.decode(input)));
    const awaitWithin = <A>(
      effect: Effect.Effect<A>,
      phaseTimeout: Duration.DurationInput,
      hardDeadline: number,
    ): Effect.Effect<Option.Option<A>> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const timeout = Math.min(
            Math.max(0, hardDeadline - now),
            durationMillis(phaseTimeout),
          );
          return timeout <= 0
            ? Effect.succeed(Option.none())
            : effect.pipe(Effect.timeoutOption(Duration.millis(timeout)));
        }),
      );
    const runShutdown = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const hardDeadline = startedAt + durationMillis(policy.totalTimeout);
      const signalsAttempted: Array<"SIGTERM" | "SIGKILL"> = [];
      let terminal = (yield* Deferred.isDone(child.exit))
        ? Option.some(yield* Effect.either(child.waitForExit))
        : Option.none<Either.Either<ProcessExit, ProcessError>>();
      const stdin =
        child.stdinAvailable && Option.isNone(terminal)
          ? yield* awaitWithin(
              Effect.either(
                child.requestStdinEnd.pipe(
                  Effect.zipRight(child.awaitStdinEnd),
                ),
              ),
              policy.stdinCloseTimeout,
              hardDeadline,
            )
          : child.stdinAvailable
            ? Option.some(Either.right(undefined))
            : undefined;

      if (Option.isNone(terminal)) {
        signalsAttempted.push("SIGTERM");
        yield* child.kill("SIGTERM").pipe(Effect.ignore);
        terminal = yield* awaitWithin(
          Effect.either(child.waitForExit),
          policy.gracefulTimeout,
          hardDeadline,
        );
      }
      if (Option.isNone(terminal)) {
        signalsAttempted.push("SIGKILL");
        yield* child.kill("SIGKILL").pipe(Effect.ignore);
        terminal = yield* awaitWithin(
          Effect.either(child.waitForExit),
          policy.forcedTimeout,
          hardDeadline,
        );
      }

      const completedAt = yield* Clock.currentTimeMillis;
      const terminalUnconfirmed = Option.isNone(terminal);
      if (terminalUnconfirmed) {
        yield* child.unref.pipe(
          Effect.catchAllCause(() => Effect.void),
          Effect.zipRight(child.closeOutput),
        );
      }
      const currentProcess = yield* processAtIndex(
        ref,
        child.index,
        "shutdown",
      );
      return {
        stdin:
          stdin === undefined
            ? ({ _tag: "Unavailable" } as const)
            : Option.match(stdin, {
                onNone: () => ({ _tag: "TimedOut" }) as const,
                onSome: Either.match({
                  onLeft: (error) => ({ _tag: "Failed" as const, error }),
                  onRight: () => ({ _tag: "Completed" }) as const,
                }),
              }),
        signalsAttempted,
        signalErrors: [],
        processErrors: currentProcess.processErrors.map(copyError),
        ...(Option.isSome(terminal)
          ? {
              terminal: Either.match(terminal.value, {
                onLeft: (error) => ({ _tag: "Failed" as const, error }),
                onRight: (exit) => ({ _tag: "Exited" as const, exit }),
              }),
            }
          : {}),
        terminalUnconfirmed,
        deadlineExceeded: terminalUnconfirmed && completedAt >= hardDeadline,
      };
    });
    return Effect.cached(
      Effect.uninterruptibleMask(() =>
        Effect.forkDaemon(Effect.interruptible(runShutdown)).pipe(
          Effect.flatMap(Fiber.join),
        ),
      ),
    ).pipe(
      Effect.map(
        (shutdown) =>
          ({
            ...child,
            shutdown,
          }) satisfies ManagedProcess,
      ),
    );
  };

  return {
    spawnScoped: (command, args, options, policy) =>
      Ref.update(ref, (state) => ({
        ...state,
        managedSpawnCount: state.managedSpawnCount + 1,
      })).pipe(
        Effect.zipRight(
          Effect.acquireRelease(
            spawnProcess(command, args, options).pipe(
              Effect.flatMap((child) => managed(child, policy)),
            ),
            (child) =>
              child.shutdown.pipe(
                Effect.ensuring(child.closeOutput),
                Effect.asVoid,
              ),
          ),
        ),
      ),
    spawnDetached: (command, args, options) =>
      Effect.uninterruptibleMask((restore) =>
        Ref.update(ref, (state) => ({
          ...state,
          detachedSpawnCount: state.detachedSpawnCount + 1,
        })).pipe(
          Effect.zipRight(
            spawnProcess(command, args, {
              ...options,
              detached: true,
              stdio: "ignore",
            }),
          ),
          Effect.flatMap((child) =>
            restore(child.awaitLaunch).pipe(
              Effect.onInterrupt(() => child.unref.pipe(Effect.ignore)),
              Effect.zipRight(child.unref),
            ),
          ),
        ),
      ),
  };
};

const makeProcessServiceTest = (
  ref: ProcessServiceTestRef,
): ProcessServiceTestService => ({
  emitLaunch: (index) =>
    processAtIndex(ref, index, "emitLaunch").pipe(
      Effect.flatMap((process) =>
        Deferred.succeed(process.launch, undefined).pipe(Effect.asVoid),
      ),
    ),
  emitLaunchFailure: (index, error) =>
    processAtIndex(ref, index, "emitLaunchFailure").pipe(
      Effect.flatMap((process) => {
        const copiedError = copyError(error);
        return Deferred.fail(process.launch, copiedError).pipe(
          Effect.flatMap((pendingLaunch) =>
            pendingLaunch
              ? Deferred.fail(process.exit, copiedError).pipe(
                  Effect.zipRight(process.stdout.end),
                  Effect.zipRight(process.stderr.end),
                )
              : Effect.void,
          ),
        );
      }),
      Effect.asVoid,
    ),
  emitStdout: (index, line) =>
    processAtIndex(ref, index, "emitStdout").pipe(
      Effect.flatMap((process) => process.stdout.offer(line)),
      Effect.asVoid,
    ),
  emitStdoutFailure: (index, error) =>
    processAtIndex(ref, index, "emitStdoutFailure").pipe(
      Effect.flatMap((process) => process.stdout.fail(copyError(error))),
      Effect.asVoid,
    ),
  emitStderr: (index, chunk) =>
    processAtIndex(ref, index, "emitStderr").pipe(
      Effect.flatMap((process) => process.stderr.offer(chunk)),
      Effect.asVoid,
    ),
  emitExit: (index, processExit) =>
    processAtIndex(ref, index, "emitExit").pipe(
      Effect.flatMap((process) =>
        Deferred.succeed(process.exit, { ...processExit }),
      ),
      Effect.asVoid,
    ),
  emitOutputEnd: (index) =>
    processAtIndex(ref, index, "emitOutputEnd").pipe(
      Effect.flatMap((process) =>
        process.stdout.end.pipe(Effect.zipRight(process.stderr.end)),
      ),
      Effect.asVoid,
    ),
  complete: (index, processExit) =>
    processAtIndex(ref, index, "complete").pipe(
      Effect.flatMap((process) =>
        Deferred.succeed(process.exit, { ...processExit }).pipe(
          Effect.zipRight(process.stdout.end),
          Effect.zipRight(process.stderr.end),
        ),
      ),
      Effect.asVoid,
    ),
  emitError: (index, error) =>
    processAtIndex(ref, index, "emitError").pipe(
      Effect.flatMap((process) => {
        const copiedError = copyError(error);
        return Deferred.fail(process.exit, copiedError).pipe(
          Effect.zipRight(process.stdout.fail(copiedError)),
          Effect.zipRight(process.stderr.fail(copiedError)),
        );
      }),
      Effect.asVoid,
    ),
  emitPostLaunchError: (index, error) =>
    processAtIndex(ref, index, "emitPostLaunchError").pipe(
      Effect.zipRight(
        Ref.update(ref, (state) => ({
          ...state,
          processes: updateProcessAt(state, index, (process) => ({
            ...process,
            processErrors: [...process.processErrors, copyError(error)],
          })),
        })),
      ),
    ),
  getState: snapshotState(ref),
  resetCalls: Ref.update(ref, (state) => ({
    ...state,
    calls: [],
    managedSpawnCount: 0,
    detachedSpawnCount: 0,
    stdinWrites: [],
    stdinEndCount: 0,
    signals: [],
    lifecycleEvents: [],
    outputCloseCount: 0,
    unrefCount: 0,
    processes: state.processes.map((process) => ({
      ...process,
      stdinWrites: [],
      stdinEndCount: 0,
      signals: [],
      lifecycleEvents: [],
      outputCloseCount: 0,
      unrefCount: 0,
    })),
  })),
  reset: Ref.set(ref, initialState()),
});

const makeProcessServiceTestLayer = (config: ProcessServiceTestConfig = {}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const ref = yield* Ref.make(initialState());
      return Context.add(
        Context.make(ProcessService, makeProcessService(ref, config)),
        ProcessServiceTest,
        makeProcessServiceTest(ref),
      );
    }),
  );

export class ProcessServiceTest extends Context.Tag("ProcessServiceTest")<
  ProcessServiceTest,
  ProcessServiceTestService
>() {
  static readonly layer = makeProcessServiceTestLayer;
}
