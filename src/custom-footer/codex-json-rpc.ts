import { join } from "node:path";
import {
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Ref,
  Stream,
} from "effect";
import { EnvironmentService } from "../services/environment";
import {
  type FileSystemError,
  FileSystemService,
} from "../services/file-system";
import { HomeDirectoryService } from "../services/home-directory";
import {
  type ManagedProcess,
  type ProcessError,
  ProcessService,
  type ProcessExit,
} from "../services/process";
import {
  type RateLimitProtocolError,
  type RateLimitSnapshot,
  decodeInitializeJsonRpcLine,
  decodeRateLimitsJsonRpcLine,
  encodeInitializeRequest,
  encodeRateLimitsReadRequest,
  selectCodexRateLimit,
} from "./rate-limits";

export class CodexRateLimitError extends Data.TaggedError(
  "CodexRateLimitError",
)<{
  readonly reason: "timeout" | "early-exit";
  readonly message: string;
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderr?: string;
}> {}

export type RateLimitReadError =
  CodexRateLimitError | FileSystemError | ProcessError | RateLimitProtocolError;

const stderrLimit = 500;
const requestTimeout = Duration.seconds(20);
const shutdownPolicy = {
  stdinCloseTimeout: Duration.millis(100),
  gracefulTimeout: Duration.seconds(1),
  forcedTimeout: Duration.seconds(1),
  totalTimeout: Duration.millis(2_100),
};

export const findCodexBinary: Effect.Effect<
  string,
  FileSystemError,
  EnvironmentService | FileSystemService | HomeDirectoryService
> = Effect.gen(function* () {
  const environment = yield* EnvironmentService;
  const configured = yield* environment.get("CODEX_BIN");
  if (configured !== undefined && configured.length > 0) return configured;

  const homeDirectory = yield* HomeDirectoryService;
  const fileSystem = yield* FileSystemService;
  const home = yield* homeDirectory.get;
  const candidates = [
    join(home, ".cache", ".bun", "bin", "codex"),
    join(home, ".nix-profile", "bin", "codex"),
  ];

  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate)) return candidate;
  }
  return "codex";
});

const completeFailure = (
  result: Deferred.Deferred<RateLimitSnapshot, RateLimitReadError>,
  error: RateLimitReadError,
): Effect.Effect<void> => Deferred.fail(result, error).pipe(Effect.asVoid);

const appendStderr = (
  stderr: Ref.Ref<string>,
  chunk: string,
): Effect.Effect<void> =>
  Ref.update(stderr, (current) => `${current}${chunk}`.slice(-stderrLimit));

const earlyExitError = (
  processExit: ProcessExit,
  stderr: string,
): CodexRateLimitError =>
  new CodexRateLimitError({
    reason: "early-exit",
    message: `Codex exited before returning rate limits (code ${String(processExit.code)}, signal ${String(processExit.signal)})${stderr.length === 0 ? "" : `: ${stderr}`}`,
    code: processExit.code,
    signal: processExit.signal,
    stderr,
  });

const runSession = (
  child: ManagedProcess,
): Effect.Effect<RateLimitSnapshot, RateLimitReadError> =>
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* Deferred.make<
          RateLimitSnapshot,
          RateLimitReadError
        >();
        const initialized = yield* Ref.make(false);
        const stderr = yield* Ref.make("");
        const stdoutJsonLines = child.stdoutChunks.pipe(Stream.splitLines);

        const stderrFiber = yield* Effect.forkScoped(
          restore(
            Stream.runForEach(child.stderrChunks, (chunk) =>
              appendStderr(stderr, chunk),
            ).pipe(
              Effect.catchAll((error) => completeFailure(result, error)),
              Effect.asVoid,
            ),
          ),
        );

        yield* Effect.forkScoped(
          restore(
            Stream.runForEach(stdoutJsonLines, (line) =>
              Ref.get(initialized).pipe(
                Effect.flatMap((isInitialized) =>
                  isInitialized
                    ? decodeRateLimitsJsonRpcLine(line).pipe(
                        Effect.flatMap(
                          Option.match({
                            onNone: () => Effect.void,
                            onSome: (response) => {
                              const snapshot = selectCodexRateLimit(response);
                              return snapshot === null
                                ? Effect.void
                                : Deferred.succeed(result, snapshot).pipe(
                                    Effect.asVoid,
                                  );
                            },
                          }),
                        ),
                      )
                    : decodeInitializeJsonRpcLine(line).pipe(
                        Effect.flatMap(
                          Option.match({
                            onNone: () => Effect.void,
                            onSome: () =>
                              Ref.getAndSet(initialized, true).pipe(
                                Effect.flatMap((alreadyInitialized) =>
                                  alreadyInitialized
                                    ? Effect.void
                                    : child.writeStdin(
                                        `${encodeRateLimitsReadRequest()}\n`,
                                      ),
                                ),
                              ),
                          }),
                        ),
                      ),
                ),
              ),
            ).pipe(
              Effect.catchAll((error) => completeFailure(result, error)),
              Effect.asVoid,
            ),
          ),
        );

        yield* Effect.forkScoped(
          restore(
            child.waitForExit.pipe(
              Effect.flatMap((processExit) =>
                Fiber.await(stderrFiber).pipe(
                  Effect.zipRight(Ref.get(stderr)),
                  Effect.flatMap((capturedStderr) =>
                    completeFailure(
                      result,
                      earlyExitError(processExit, capturedStderr),
                    ),
                  ),
                ),
              ),
              Effect.catchAll((error) => completeFailure(result, error)),
              Effect.asVoid,
            ),
          ),
        );

        yield* child.writeStdin(`${encodeInitializeRequest()}\n`);

        return yield* restore(Deferred.await(result)).pipe(
          Effect.timeoutFail({
            duration: requestTimeout,
            onTimeout: () =>
              new CodexRateLimitError({
                reason: "timeout",
                message: "Timed out waiting 20 seconds for Codex rate limits",
              }),
          }),
        );
      }),
    ),
  );

const scopedReadOpenAiRateLimits = Effect.gen(function* () {
  const environment = yield* EnvironmentService;
  const homeDirectory = yield* HomeDirectoryService;
  const processService = yield* ProcessService;
  const command = yield* findCodexBinary;
  const home = yield* homeDirectory.get;
  const environmentSnapshot = yield* environment.snapshot;
  const env = { ...environmentSnapshot };

  const child = yield* processService.spawnScoped(
    command,
    ["app-server", "--stdio"],
    {
      cwd: home,
      env,
      stdio: "pipe",
    },
    shutdownPolicy,
  );

  return yield* runSession(child);
});

export const readOpenAiRateLimits: Effect.Effect<
  RateLimitSnapshot,
  RateLimitReadError,
  EnvironmentService | FileSystemService | HomeDirectoryService | ProcessService
> = Effect.scoped(scopedReadOpenAiRateLimits);
