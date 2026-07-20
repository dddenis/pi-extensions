import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  Cause,
  Chunk,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Either,
  Layer,
  Option,
  Ref,
  Runtime,
  Scope,
  Stream,
} from "effect";

export interface SpawnProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly detached?: boolean;
  readonly stdio: "ignore" | "pipe";
}

export interface SpawnDetachedProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly operation: "spawn" | "stdin" | "stream" | "wait" | "kill" | "unref";
  readonly message: string;
}> {}

export interface SpawnedProcess {
  readonly writeStdin: (value: string) => Effect.Effect<void, ProcessError>;
  readonly endStdin: Effect.Effect<void, ProcessError>;
  readonly stdoutChunks: Stream.Stream<string, ProcessError>;
  readonly stderrChunks: Stream.Stream<string, ProcessError>;
  /** Replayable: every evaluation observes the same terminal exit/error result. */
  readonly waitForExit: Effect.Effect<ProcessExit, ProcessError>;
  readonly kill: (
    signal: "SIGTERM" | "SIGKILL",
  ) => Effect.Effect<void, ProcessError>;
  readonly unref: Effect.Effect<void, ProcessError>;
}

export interface ProcessShutdownPolicy {
  readonly stdinCloseTimeout: Duration.DurationInput;
  readonly gracefulTimeout: Duration.DurationInput;
  readonly forcedTimeout: Duration.DurationInput;
  readonly totalTimeout: Duration.DurationInput;
}

export type ProcessStdinShutdown =
  | { readonly _tag: "Completed" }
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Failed"; readonly error: ProcessError }
  | { readonly _tag: "TimedOut" };

export type ProcessTerminalResult =
  | { readonly _tag: "Exited"; readonly exit: ProcessExit }
  | { readonly _tag: "Failed"; readonly error: ProcessError };

export interface ProcessShutdownReport {
  readonly stdin: ProcessStdinShutdown;
  readonly signalsAttempted: ReadonlyArray<"SIGTERM" | "SIGKILL">;
  readonly signalErrors: ReadonlyArray<ProcessError>;
  readonly processErrors: ReadonlyArray<ProcessError>;
  readonly terminal?: ProcessTerminalResult;
  readonly terminalUnconfirmed: boolean;
  readonly deadlineExceeded: boolean;
  readonly internalFailure?: string;
}

type ProcessShutdownElection =
  | {
      readonly leader: true;
      readonly deferred: Deferred.Deferred<ProcessShutdownReport>;
    }
  | {
      readonly leader: false;
      readonly deferred: Deferred.Deferred<ProcessShutdownReport>;
    };

export interface ManagedProcess extends SpawnedProcess {
  /** Initiates EOF without waiting for buffered writes to finish. */
  readonly requestStdinEnd: Effect.Effect<void, ProcessError>;
  /** Replayable completion of the EOF request. */
  readonly awaitStdinEnd: Effect.Effect<void, ProcessError>;
  /** Idempotent, replayable, and bounded by the acquisition policy. */
  readonly shutdown: Effect.Effect<ProcessShutdownReport>;
}

export interface ProcessService {
  readonly spawnScoped: (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnProcessOptions,
    shutdownPolicy: ProcessShutdownPolicy,
  ) => Effect.Effect<ManagedProcess, ProcessError, Scope.Scope>;
  readonly spawnDetached: (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnDetachedProcessOptions,
  ) => Effect.Effect<void, ProcessError>;
}

export interface ProcessTerminationConfig {
  readonly gracefulTimeout: Duration.DurationInput;
  readonly forcedTimeout: Duration.DurationInput;
}

const ProcessServiceTag = Context.GenericTag<ProcessService>(
  "pi-extensions/ProcessService",
);

const messageFrom = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const processError = (
  operation: ProcessError["operation"],
  cause: unknown,
): ProcessError => new ProcessError({ operation, message: messageFrom(cause) });

const streamBufferSize = 16;

const readableChunks = (
  readable: Readable,
): Stream.Stream<string, ProcessError> =>
  Stream.async<string, ProcessError>((emit) => {
    let active = true;
    const decoder = new StringDecoder("utf8");
    const onData = (chunk: Buffer | string): void => {
      if (!active) return;
      readable.pause();
      const decoded = decoder.write(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
      if (decoded === "") {
        if (active) readable.resume();
        return;
      }
      void emit(Effect.succeed(Chunk.of(decoded))).then(
        () => {
          if (active) readable.resume();
        },
        () => undefined,
      );
    };
    const onEnd = (): void => {
      active = false;
      const trailing = decoder.end();
      if (trailing === "") {
        void emit(Effect.fail(Option.none()));
        return;
      }
      void emit(Effect.succeed(Chunk.of(trailing))).then(
        () => emit(Effect.fail(Option.none())),
        () => undefined,
      );
    };
    const onError = (cause: unknown): void => {
      active = false;
      void emit(Effect.fail(Option.some(processError("stream", cause))));
    };
    const onClose = (): void => {
      if (!active) return;
      active = false;
      void emit(
        Effect.fail(
          Option.some(
            new ProcessError({
              operation: "stream",
              message: "readable stream closed before end",
            }),
          ),
        ),
      );
    };
    readable.on("data", onData);
    readable.once("end", onEnd);
    readable.once("error", onError);
    readable.once("close", onClose);

    return Effect.sync(() => {
      active = false;
      readable.pause();
      readable.off("data", onData);
      readable.off("end", onEnd);
      readable.off("error", onError);
      readable.off("close", onClose);
    });
  }, streamBufferSize);

const writeToStdin = (
  stdin: Writable | null,
  operation: (complete: (error?: Error | null) => void) => void,
): Effect.Effect<void, ProcessError> => {
  if (stdin === null) {
    return Effect.fail(
      new ProcessError({
        operation: "stdin",
        message:
          "stdin is unavailable for a process spawned with ignored stdio",
      }),
    );
  }

  return Effect.async<void, ProcessError>((resume) => {
    let completed = false;
    const complete = (error?: Error | null): void => {
      if (completed) return;
      completed = true;
      stdin.off("error", onError);
      resume(
        error === undefined || error === null
          ? Effect.void
          : Effect.fail(processError("stdin", error)),
      );
    };
    const onError = (cause: unknown): void => {
      complete(cause instanceof Error ? cause : new Error(String(cause)));
    };

    stdin.once("error", onError);
    try {
      operation(complete);
    } catch (cause) {
      complete(cause instanceof Error ? cause : new Error(String(cause)));
    }

    return Effect.sync(() => {
      completed = true;
      stdin.off("error", onError);
    });
  });
};

const defaultShutdownPolicy: ProcessShutdownPolicy = {
  stdinCloseTimeout: Duration.millis(100),
  gracefulTimeout: Duration.seconds(1),
  forcedTimeout: Duration.seconds(1),
  totalTimeout: Duration.millis(2_100),
};

interface NormalizedShutdownPolicy {
  readonly stdinCloseTimeout: Duration.Duration;
  readonly gracefulTimeout: Duration.Duration;
  readonly forcedTimeout: Duration.Duration;
  readonly totalTimeout: Duration.Duration;
}

const normalizeShutdownPolicy = (
  policy: ProcessShutdownPolicy,
): Effect.Effect<NormalizedShutdownPolicy, ProcessError> =>
  Effect.gen(function* () {
    const normalize = (
      name: keyof ProcessShutdownPolicy,
      input: Duration.DurationInput,
    ): Effect.Effect<Duration.Duration, ProcessError> => {
      const duration = Duration.decode(input);
      return Option.isSome(Duration.toNanos(duration))
        ? Effect.succeed(duration)
        : Effect.fail(
            new ProcessError({
              operation: "spawn",
              message: `${name} must be finite`,
            }),
          );
    };

    return {
      stdinCloseTimeout: yield* normalize(
        "stdinCloseTimeout",
        policy.stdinCloseTimeout,
      ),
      gracefulTimeout: yield* normalize(
        "gracefulTimeout",
        policy.gracefulTimeout,
      ),
      forcedTimeout: yield* normalize("forcedTimeout", policy.forcedTimeout),
      totalTimeout: yield* normalize("totalTimeout", policy.totalTimeout),
    };
  });

const durationNanos = (duration: Duration.Duration): bigint =>
  Option.getOrElse(Duration.toNanos(duration), () => 0n);

const awaitWithin = <A>(
  effect: Effect.Effect<A>,
  phaseTimeout: Duration.Duration,
  hardDeadline: bigint,
): Effect.Effect<Option.Option<A>> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeNanos;
    const remaining = hardDeadline > now ? hardDeadline - now : 0n;
    const phase = durationNanos(phaseTimeout);
    const timeout = remaining < phase ? remaining : phase;
    return timeout <= 0n
      ? Option.none()
      : yield* effect.pipe(Effect.timeoutOption(Duration.nanos(timeout)));
  });

interface SpawnedProcessLaunch {
  readonly managed: ManagedProcess;
  readonly awaitLaunch: Effect.Effect<void, ProcessError>;
}

const makeSpawnedProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnProcessOptions,
  shutdownPolicy: ProcessShutdownPolicy,
): Effect.Effect<SpawnedProcessLaunch, ProcessError> =>
  Effect.gen(function* () {
    const policy = yield* normalizeShutdownPolicy(shutdownPolicy);
    const launch = yield* Deferred.make<void, ProcessError>();
    const exit = yield* Deferred.make<ProcessExit, ProcessError>();
    const stdinEnd = yield* Deferred.make<void, ProcessError>();
    const stdinEndRequested = yield* Ref.make(false);
    const processErrorsRef = yield* Ref.make<ReadonlyArray<ProcessError>>([]);
    const shutdownRef = yield* Ref.make<
      Option.Option<Deferred.Deferred<ProcessShutdownReport>>
    >(Option.none());
    const runtime = yield* Effect.runtime<never>();
    const runFork = Runtime.runFork(runtime);
    const copiedArgs = [...args];
    const copiedEnv =
      options.env === undefined ? undefined : { ...options.env };
    let lastSignalRequested: "SIGTERM" | "SIGKILL" | undefined;
    const child = yield* Effect.try({
      try: () => {
        const acquired = spawn(command, copiedArgs, {
          cwd: options.cwd,
          env: copiedEnv,
          detached: options.detached,
          stdio: options.stdio,
        });
        let terminal = false;
        let spawnedSuccessfully = acquired.pid !== undefined;

        const onSpawn = (): void => {
          spawnedSuccessfully = true;
          runFork(Deferred.succeed(launch, undefined));
        };
        const onExit = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ): void => {
          if (terminal) return;
          terminal = true;
          acquired.off("spawn", onSpawn);
          acquired.off("error", onError);
          runFork(Deferred.succeed(exit, { code, signal }));
        };
        const onError = (cause: Error): void => {
          if (terminal) return;
          if (spawnedSuccessfully) {
            const operation =
              lastSignalRequested === undefined ? "wait" : "kill";
            runFork(
              Ref.update(processErrorsRef, (errors) => [
                ...errors,
                processError(operation, cause),
              ]),
            );
            return;
          }
          terminal = true;
          acquired.off("spawn", onSpawn);
          acquired.off("exit", onExit);
          acquired.off("error", onError);
          const error = processError("spawn", cause);
          runFork(Deferred.fail(launch, error));
          runFork(Deferred.fail(exit, error));
        };

        acquired.once("spawn", onSpawn);
        acquired.once("exit", onExit);
        acquired.on("error", onError);
        return acquired;
      },
      catch: (cause) => processError("spawn", cause),
    });

    const stdin = child.stdin;
    const stdinUnavailable = new ProcessError({
      operation: "stdin",
      message: "stdin is unavailable for a process spawned with ignored stdio",
    });
    const stdoutChunks =
      options.stdio === "pipe" && child.stdout !== null
        ? readableChunks(child.stdout)
        : Stream.empty;
    const stderrChunks =
      options.stdio === "pipe" && child.stderr !== null
        ? readableChunks(child.stderr)
        : Stream.empty;
    const waitForExit = Deferred.await(exit);
    const terminalResult: Effect.Effect<ProcessTerminalResult> =
      waitForExit.pipe(
        Effect.match({
          onFailure: (error) =>
            ({ _tag: "Failed", error }) satisfies ProcessTerminalResult,
          onSuccess: (processExit) =>
            ({
              _tag: "Exited",
              exit: processExit,
            }) satisfies ProcessTerminalResult,
        }),
      );
    const pollTerminal: Effect.Effect<Option.Option<ProcessTerminalResult>> =
      Deferred.poll(exit).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none()),
            onSome: (terminal) =>
              terminal.pipe(
                Effect.match({
                  onFailure: (error) =>
                    ({ _tag: "Failed", error }) satisfies ProcessTerminalResult,
                  onSuccess: (processExit) =>
                    ({
                      _tag: "Exited",
                      exit: processExit,
                    }) satisfies ProcessTerminalResult,
                }),
                Effect.map(Option.some),
              ),
          }),
        ),
      );

    const requestStdinEnd: Effect.Effect<void, ProcessError> = (
      stdin === null
        ? Effect.fail(stdinUnavailable)
        : Ref.getAndSet(stdinEndRequested, true).pipe(
            Effect.flatMap((alreadyRequested) => {
              if (alreadyRequested) return Effect.void;

              let removeListeners = (): void => undefined;
              const complete = (error?: Error | null): void => {
                removeListeners();
                runFork(
                  error === undefined || error === null
                    ? Deferred.succeed(stdinEnd, undefined)
                    : Deferred.fail(stdinEnd, processError("stdin", error)),
                );
              };
              const onError = (cause: unknown): void => {
                complete(
                  cause instanceof Error ? cause : new Error(String(cause)),
                );
              };
              const onClose = (): void => {
                complete(new Error("stdin closed before EOF completed"));
              };
              removeListeners = () => {
                stdin.off("error", onError);
                stdin.off("close", onClose);
              };

              return Effect.try({
                try: () => {
                  stdin.once("error", onError);
                  stdin.once("close", onClose);
                  stdin.end(complete);
                },
                catch: (cause) => {
                  const error = processError("stdin", cause);
                  removeListeners();
                  runFork(Deferred.fail(stdinEnd, error));
                  return error;
                },
              });
            }),
          )
    ).pipe(Effect.uninterruptible);
    const awaitStdinEnd =
      stdin === null ? Effect.fail(stdinUnavailable) : Deferred.await(stdinEnd);
    const kill = (signal: "SIGTERM" | "SIGKILL") =>
      Effect.try({
        try: () => {
          lastSignalRequested = signal;
          if (!child.kill(signal)) {
            throw new Error(`process did not accept ${signal}`);
          }
        },
        catch: (cause) => processError("kill", cause),
      });
    const unref = Effect.try({
      try: () => child.unref(),
      catch: (cause) => processError("unref", cause),
    });

    const abandonLocalHandles = Effect.sync(() => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }).pipe(Effect.catchAllCause(() => Effect.void));

    const runShutdown: Effect.Effect<ProcessShutdownReport> = Effect.gen(
      function* () {
        const startedAt = yield* Clock.currentTimeNanos;
        const hardDeadline = startedAt + durationNanos(policy.totalTimeout);
        const signalsAttempted: Array<"SIGTERM" | "SIGKILL"> = [];
        const signalErrors: Array<ProcessError> = [];
        let terminal = yield* pollTerminal;

        let stdinOutcome: ProcessStdinShutdown =
          stdin === null ? { _tag: "Unavailable" } : { _tag: "Completed" };
        if (Option.isNone(terminal)) {
          if (stdin !== null) {
            const request = yield* Effect.either(requestStdinEnd);
            if (Either.isLeft(request)) {
              stdinOutcome = { _tag: "Failed", error: request.left };
            } else {
              const completed = yield* awaitWithin(
                Effect.either(awaitStdinEnd),
                policy.stdinCloseTimeout,
                hardDeadline,
              );
              stdinOutcome = Option.match(completed, {
                onNone: () => ({ _tag: "TimedOut" }),
                onSome: Either.match({
                  onLeft: (error) => ({ _tag: "Failed", error }),
                  onRight: () => ({ _tag: "Completed" }),
                }),
              });
            }
          }
          terminal = yield* pollTerminal;
        }

        if (Option.isNone(terminal)) {
          signalsAttempted.push("SIGTERM");
          const result = yield* Effect.either(kill("SIGTERM"));
          if (Either.isLeft(result)) signalErrors.push(result.left);
          terminal = yield* awaitWithin(
            terminalResult,
            policy.gracefulTimeout,
            hardDeadline,
          );
        }

        if (Option.isNone(terminal)) {
          signalsAttempted.push("SIGKILL");
          const result = yield* Effect.either(kill("SIGKILL"));
          if (Either.isLeft(result)) signalErrors.push(result.left);
          terminal = yield* awaitWithin(
            terminalResult,
            policy.forcedTimeout,
            hardDeadline,
          );
        }

        const asynchronousErrors = yield* Ref.get(processErrorsRef);
        const terminalUnconfirmed = Option.isNone(terminal);
        const completedAt = yield* Clock.currentTimeNanos;
        const deadlineExceeded =
          terminalUnconfirmed && completedAt >= hardDeadline;
        if (terminalUnconfirmed) yield* abandonLocalHandles;
        return {
          stdin: stdinOutcome,
          signalsAttempted,
          signalErrors: [
            ...signalErrors,
            ...asynchronousErrors.filter((error) => error.operation === "kill"),
          ],
          processErrors: asynchronousErrors,
          ...(Option.isSome(terminal) ? { terminal: terminal.value } : {}),
          terminalUnconfirmed,
          deadlineExceeded,
        } satisfies ProcessShutdownReport;
      },
    );

    const shutdown: Effect.Effect<ProcessShutdownReport> =
      Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<ProcessShutdownReport>();
          const election = yield* Ref.modify(
            shutdownRef,
            (
              current,
            ): readonly [
              ProcessShutdownElection,
              Option.Option<Deferred.Deferred<ProcessShutdownReport>>,
            ] =>
              Option.isSome(current)
                ? [{ leader: false, deferred: current.value }, current]
                : [
                    { leader: true, deferred: candidate },
                    Option.some(candidate),
                  ],
          );
          if (election.leader) {
            yield* Effect.forkDaemon(
              Effect.interruptible(runShutdown).pipe(
                Effect.catchAllCause((cause) =>
                  abandonLocalHandles.pipe(
                    Effect.as({
                      stdin: { _tag: "TimedOut" },
                      signalsAttempted: [],
                      signalErrors: [],
                      processErrors: [],
                      terminalUnconfirmed: true,
                      deadlineExceeded: false,
                      internalFailure: Cause.pretty(cause),
                    } satisfies ProcessShutdownReport),
                  ),
                ),
                Effect.flatMap((report) =>
                  Deferred.succeed(election.deferred, report),
                ),
                Effect.asVoid,
              ),
            );
          }
          return yield* Deferred.await(election.deferred);
        }),
      );

    return {
      managed: {
        writeStdin: (value) =>
          writeToStdin(stdin, (complete) => {
            stdin?.write(value, "utf8", complete);
          }),
        requestStdinEnd,
        awaitStdinEnd,
        endStdin: requestStdinEnd.pipe(Effect.zipRight(awaitStdinEnd)),
        stdoutChunks,
        stderrChunks,
        waitForExit,
        kill,
        unref,
        shutdown,
      } satisfies ManagedProcess,
      awaitLaunch: Deferred.await(launch),
    } satisfies SpawnedProcessLaunch;
  });

const spawnScoped = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnProcessOptions,
  shutdownPolicy: ProcessShutdownPolicy,
): Effect.Effect<ManagedProcess, ProcessError, Scope.Scope> =>
  Effect.acquireRelease(
    makeSpawnedProcess(command, args, options, shutdownPolicy).pipe(
      Effect.map((launch) => launch.managed),
    ),
    (managed) => managed.shutdown.pipe(Effect.asVoid),
  );

const spawnDetached = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnDetachedProcessOptions,
): Effect.Effect<void, ProcessError> =>
  Effect.uninterruptibleMask((restore) =>
    makeSpawnedProcess(
      command,
      args,
      { ...options, detached: true, stdio: "ignore" },
      defaultShutdownPolicy,
    ).pipe(
      Effect.flatMap(({ managed, awaitLaunch }) =>
        restore(awaitLaunch).pipe(
          Effect.onInterrupt(() => managed.unref.pipe(Effect.ignore)),
          Effect.zipRight(managed.unref),
        ),
      ),
    ),
  );

export const ProcessService = Object.assign(ProcessServiceTag, {
  Live: Layer.succeed(ProcessServiceTag, {
    spawnScoped,
    spawnDetached,
  } satisfies ProcessService),
});

export const terminateProcess = (
  child: SpawnedProcess,
  config: ProcessTerminationConfig,
): Effect.Effect<void> =>
  child.kill("SIGTERM").pipe(
    Effect.ignore,
    Effect.zipRight(
      child.waitForExit.pipe(
        Effect.asVoid,
        Effect.timeoutOption(config.gracefulTimeout),
      ),
    ),
    Effect.flatMap((exit) =>
      Option.isSome(exit)
        ? Effect.void
        : child
            .kill("SIGKILL")
            .pipe(
              Effect.ignore,
              Effect.zipRight(
                child.waitForExit.pipe(
                  Effect.asVoid,
                  Effect.timeout(config.forcedTimeout),
                  Effect.ignore,
                ),
              ),
            ),
    ),
    Effect.catchAllCause(() => Effect.void),
  );
