import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Either,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
  Take,
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
}

export interface ProcessServiceTestCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnProcessOptions;
}

export interface ProcessServiceTestState {
  readonly calls: ReadonlyArray<ProcessServiceTestCall>;
  readonly managedSpawnCount: number;
  readonly detachedSpawnCount: number;
  readonly stdinWrites: ReadonlyArray<string>;
  readonly stdinEndCount: number;
  readonly signals: ReadonlyArray<"SIGTERM" | "SIGKILL">;
  readonly lifecycleEvents: ReadonlyArray<string>;
  readonly unrefCount: number;
}

export interface ProcessServiceTestService {
  readonly emitStdout: (line: string) => Effect.Effect<void>;
  readonly emitStderr: (chunk: string) => Effect.Effect<void>;
  readonly emitExit: (exit: ProcessExit) => Effect.Effect<void>;
  readonly emitError: (error: ProcessError) => Effect.Effect<void>;
  readonly getState: Effect.Effect<ProcessServiceTestState>;
  readonly resetCalls: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

type ProcessEventQueue = Queue.Queue<Take.Take<string, ProcessError>>;
type TestSpawnedProcess = SpawnedProcess &
  Pick<ManagedProcess, "requestStdinEnd" | "awaitStdinEnd">;

interface ActiveProcess {
  readonly exit: Deferred.Deferred<ProcessExit, ProcessError>;
  readonly stdout: ProcessEventQueue;
  readonly stderr: ProcessEventQueue;
}

interface ProcessServiceTestInternalState extends ProcessServiceTestState {
  readonly active?: ActiveProcess;
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
  unrefCount: 0,
});

const copyOptions = (options: SpawnProcessOptions): SpawnProcessOptions => ({
  ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options.env === undefined ? {} : { env: { ...options.env } }),
  ...(options.detached === undefined ? {} : { detached: options.detached }),
  stdio: options.stdio,
});

const copyCall = (call: ProcessServiceTestCall): ProcessServiceTestCall => ({
  command: call.command,
  args: [...call.args],
  options: copyOptions(call.options),
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
      unrefCount: state.unrefCount,
    })),
  );

const activeProcess = (
  ref: ProcessServiceTestRef,
  operation: string,
): Effect.Effect<ActiveProcess> =>
  Ref.get(ref).pipe(
    Effect.flatMap((state) =>
      state.active === undefined
        ? Effect.die(
            new Error(
              `ProcessServiceTest.${operation} requires a spawned process`,
            ),
          )
        : Effect.succeed(state.active),
    ),
  );

const copyError = (error: ProcessError): ProcessError =>
  new ProcessError({ operation: error.operation, message: error.message });

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
      const exit = yield* Deferred.make<ProcessExit, ProcessError>();
      const stdinEnd = yield* Deferred.make<void>();
      const stdinEndRequested = yield* Ref.make(false);
      const stdout = yield* Queue.unbounded<Take.Take<string, ProcessError>>();
      const stderr = yield* Queue.unbounded<Take.Take<string, ProcessError>>();
      const active = { exit, stdout, stderr };

      yield* Ref.update(ref, (state) => ({
        ...state,
        active,
        calls: [
          ...state.calls,
          { command, args: [...args], options: copyOptions(options) },
        ],
      }));

      const requestStdinEnd = Ref.getAndSet(stdinEndRequested, true).pipe(
        Effect.flatMap((alreadyRequested) =>
          alreadyRequested
            ? Effect.void
            : Ref.update(ref, (state) => ({
                ...state,
                stdinEndCount: state.stdinEndCount + 1,
                lifecycleEvents: [...state.lifecycleEvents, "shutdown-started"],
              })).pipe(
                Effect.zipRight(
                  config.stdinEnd === "never"
                    ? Effect.void
                    : Deferred.succeed(stdinEnd, undefined).pipe(Effect.asVoid),
                ),
              ),
        ),
      );

      return {
        writeStdin: (value) =>
          Ref.update(ref, (state) => ({
            ...state,
            stdinWrites: [...state.stdinWrites, value],
          })),
        requestStdinEnd,
        awaitStdinEnd: Deferred.await(stdinEnd),
        endStdin: requestStdinEnd.pipe(
          Effect.zipRight(Deferred.await(stdinEnd)),
        ),
        stdoutLines: Stream.fromQueue(stdout).pipe(
          Stream.flattenTake,
          Stream.ensuring(
            Ref.update(ref, (state) => ({
              ...state,
              lifecycleEvents: [...state.lifecycleEvents, "stdout-stopped"],
            })),
          ),
        ),
        stderrChunks: Stream.fromQueue(stderr).pipe(
          Stream.flattenTake,
          Stream.ensuring(
            Ref.update(ref, (state) => ({
              ...state,
              lifecycleEvents: [...state.lifecycleEvents, "stderr-stopped"],
            })),
          ),
        ),
        waitForExit: Deferred.await(exit),
        kill: (signal) =>
          Ref.update(ref, (state) => ({
            ...state,
            signals: [...state.signals, signal],
          })),
        unref: Ref.update(ref, (state) => ({
          ...state,
          unrefCount: state.unrefCount + 1,
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
      const stdin = yield* awaitWithin(
        Effect.either(
          child.requestStdinEnd.pipe(Effect.zipRight(child.awaitStdinEnd)),
        ),
        policy.stdinCloseTimeout,
        hardDeadline,
      );
      signalsAttempted.push("SIGTERM");
      yield* child.kill("SIGTERM").pipe(Effect.ignore);
      let terminal = yield* awaitWithin(
        Effect.either(child.waitForExit),
        policy.gracefulTimeout,
        hardDeadline,
      );
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
      return {
        stdin: Option.match(stdin, {
          onNone: () => ({ _tag: "TimedOut" }) as const,
          onSome: Either.match({
            onLeft: (error) => ({ _tag: "Failed" as const, error }),
            onRight: () => ({ _tag: "Completed" }) as const,
          }),
        }),
        signalsAttempted,
        signalErrors: [],
        processErrors: [],
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
      Effect.map((shutdown) => ({
        ...child,
        requestStdinEnd: child.requestStdinEnd,
        awaitStdinEnd: child.awaitStdinEnd,
        shutdown,
      })),
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
            (child) => child.shutdown.pipe(Effect.asVoid),
          ),
        ),
      ),
    spawnDetached: (command, args, options) =>
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
        Effect.flatMap((child) => child.unref),
      ),
  };
};

const makeProcessServiceTest = (
  ref: ProcessServiceTestRef,
): ProcessServiceTestService => ({
  emitStdout: (line) =>
    activeProcess(ref, "emitStdout").pipe(
      Effect.flatMap((active) => Queue.offer(active.stdout, Take.of(line))),
      Effect.asVoid,
    ),
  emitStderr: (chunk) =>
    activeProcess(ref, "emitStderr").pipe(
      Effect.flatMap((active) => Queue.offer(active.stderr, Take.of(chunk))),
      Effect.asVoid,
    ),
  emitExit: (processExit) =>
    activeProcess(ref, "emitExit").pipe(
      Effect.flatMap((active) =>
        Deferred.succeed(active.exit, { ...processExit }).pipe(
          Effect.zipRight(Queue.offer(active.stdout, Take.end)),
          Effect.zipRight(Queue.offer(active.stderr, Take.end)),
        ),
      ),
      Effect.asVoid,
    ),
  emitError: (error) =>
    activeProcess(ref, "emitError").pipe(
      Effect.flatMap((active) => {
        const copiedError = copyError(error);
        return Deferred.fail(active.exit, copiedError).pipe(
          Effect.zipRight(Queue.offer(active.stdout, Take.fail(copiedError))),
          Effect.zipRight(Queue.offer(active.stderr, Take.fail(copiedError))),
        );
      }),
      Effect.asVoid,
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
    unrefCount: 0,
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
