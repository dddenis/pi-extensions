import { describe, it } from "@effect/vitest";
import { Duration, Effect, Either, Fiber, Layer, TestClock } from "effect";
import { expect } from "vitest";
import { EnvironmentServiceTest } from "../../test/services/environment";
import { FileSystemServiceTest } from "../../test/services/file-system";
import { HomeDirectoryServiceTest } from "../../test/services/home-directory";
import { ProcessServiceTest } from "../../test/services/process";
import { ProcessError, type ProcessExit } from "../services/process";
import {
  CodexRateLimitError,
  findCodexBinary,
  readOpenAiRateLimits,
} from "./codex-json-rpc";
import {
  encodeInitializeRequest,
  encodeRateLimitsReadRequest,
} from "./rate-limits";

const home = "/os-home";
const bunCodex = `${home}/.cache/.bun/bin/codex`;
const nixCodex = `${home}/.nix-profile/bin/codex`;

const infrastructureLayer = (config?: {
  readonly environment?: Readonly<Record<string, string>>;
  readonly exists?: ReadonlyMap<string, boolean>;
  readonly stdinEnd?: "complete" | "never";
}) =>
  Layer.mergeAll(
    EnvironmentServiceTest.layer({ values: config?.environment }),
    HomeDirectoryServiceTest.layer({ homeDirectory: home }),
    FileSystemServiceTest.layer({ exists: config?.exists }),
    ProcessServiceTest.layer({ stdinEnd: config?.stdinEnd }),
  );

const initializeResult = JSON.stringify({ id: 1, result: {} });
const rateLimitResult = JSON.stringify({
  id: 2,
  result: {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25 },
    },
  },
});

const waitFor = (predicate: Effect.Effect<boolean>): Effect.Effect<void> =>
  Effect.flatMap(predicate, (ready) =>
    ready
      ? Effect.void
      : Effect.yieldNow().pipe(Effect.zipRight(waitFor(predicate))),
  );

const waitForYields = (
  predicate: Effect.Effect<boolean>,
  attempts = 100,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (yield* predicate) return true;
      yield* Effect.yieldNow();
    }
    return yield* predicate;
  });

const waitForSpawn = Effect.gen(function* () {
  const controls = yield* ProcessServiceTest;
  yield* waitFor(
    controls.getState.pipe(Effect.map((state) => state.calls.length === 1)),
  );
});

const waitForSignalCount = (count: number) =>
  Effect.gen(function* () {
    const controls = yield* ProcessServiceTest;
    yield* waitFor(
      controls.getState.pipe(
        Effect.map((state) => state.signals.length >= count),
      ),
    );
  });

const exit = (signal: ProcessExit["signal"] = "SIGTERM"): ProcessExit => ({
  code: 0,
  signal,
});

describe("findCodexBinary", () => {
  it.effect("uses a non-empty CODEX_BIN before filesystem discovery", () =>
    Effect.gen(function* () {
      expect(yield* findCodexBinary).toBe("/configured/codex");
      const files = yield* FileSystemServiceTest;
      expect((yield* files.getState).calls).toEqual([]);
    }).pipe(
      Effect.provide(
        infrastructureLayer({
          environment: { CODEX_BIN: "/configured/codex" },
        }),
      ),
    ),
  );

  it.effect("uses Bun, then Nix, then PATH fallback precedence", () =>
    Effect.gen(function* () {
      expect(yield* findCodexBinary).toBe(nixCodex);
      const files = yield* FileSystemServiceTest;
      expect((yield* files.getState).calls).toEqual([
        { operation: "exists", path: bunCodex },
        { operation: "exists", path: nixCodex },
      ]);

      yield* files.reset;
      yield* files.setExists(bunCodex, false);
      yield* files.setExists(nixCodex, false);
      expect(yield* findCodexBinary).toBe("codex");
    }).pipe(
      Effect.provide(
        infrastructureLayer({
          environment: { CODEX_BIN: "" },
          exists: new Map([
            [bunCodex, false],
            [nixCodex, true],
          ]),
        }),
      ),
    ),
  );

  it.effect("prefers the Bun binary over the Nix binary", () =>
    Effect.gen(function* () {
      expect(yield* findCodexBinary).toBe(bunCodex);
      expect((yield* (yield* FileSystemServiceTest).getState).calls).toEqual([
        { operation: "exists", path: bunCodex },
      ]);
    }).pipe(
      Effect.provide(
        infrastructureLayer({
          exists: new Map([
            [bunCodex, true],
            [nixCodex, true],
          ]),
        }),
      ),
    ),
  );
});

describe("readOpenAiRateLimits", () => {
  it.effect(
    "spawns with copied environment and writes the exact sequenced requests",
    () =>
      Effect.gen(function* () {
        const controls = yield* ProcessServiceTest;
        const request = yield* Effect.fork(readOpenAiRateLimits);
        yield* waitForSpawn;

        expect((yield* controls.getState).managedSpawnCount).toBe(1);
        expect((yield* controls.getState).calls[0]).toEqual({
          command: bunCodex,
          args: ["app-server", "--stdio"],
          options: {
            cwd: home,
            env: { HOME: "/display-home", TOKEN: "secret" },
            stdio: "pipe",
          },
        });
        expect((yield* controls.getState).stdinWrites).toEqual([
          `${encodeInitializeRequest()}\n`,
        ]);

        yield* controls.emitStdoutChunk("not json\n");
        yield* controls.emitStdoutChunk(
          `${JSON.stringify({ id: 99, result: {} })}\n`,
        );
        yield* controls.emitStdoutChunk(`${initializeResult}\n`);
        yield* waitFor(
          controls.getState.pipe(
            Effect.map((state) => state.stdinWrites.length === 2),
          ),
        );
        expect((yield* controls.getState).stdinWrites).toEqual([
          `${encodeInitializeRequest()}\n`,
          `${encodeRateLimitsReadRequest()}\n`,
        ]);

        yield* controls.emitStdoutChunk(`${rateLimitResult}\n`);
        yield* waitForSignalCount(1);
        yield* controls.emitExit(exit());
        expect(yield* Fiber.join(request)).toEqual({
          limitId: "codex",
          primary: { usedPercent: 25 },
        });

        const state = yield* controls.getState;
        expect(state.stdinEndCount).toBe(1);
        expect(state.signals).toEqual(["SIGTERM"]);
        const shutdownStarted =
          state.lifecycleEvents.indexOf("shutdown-started");
        expect(state.lifecycleEvents.indexOf("stdout-stopped")).toBeLessThan(
          shutdownStarted,
        );
        expect(state.lifecycleEvents.indexOf("stderr-stopped")).toBeLessThan(
          shutdownStarted,
        );
      }).pipe(
        Effect.provide(
          infrastructureLayer({
            environment: { HOME: "/display-home", TOKEN: "secret" },
            exists: new Map([[bunCodex, true]]),
          }),
        ),
      ),
  );

  it.effect(
    "fails matching initialize and read errors and invalid correlated payloads",
    () =>
      Effect.gen(function* () {
        const controls = yield* ProcessServiceTest;
        const cases = [
          JSON.stringify({ id: 1, error: { message: "initialize failed" } }),
          JSON.stringify({ id: 1, result: null }),
        ];

        for (const line of cases) {
          const request = yield* Effect.fork(readOpenAiRateLimits);
          yield* waitForSpawn;
          yield* controls.emitStdoutChunk(`${line}\n`);
          yield* waitForSignalCount(1);
          yield* controls.emitExit(exit());
          const result = yield* Effect.either(Fiber.join(request));
          expect(Either.isLeft(result)).toBe(true);
          yield* controls.reset;
        }

        const request = yield* Effect.fork(readOpenAiRateLimits);
        yield* waitForSpawn;
        yield* controls.emitStdoutChunk(`${initializeResult}\n`);
        yield* controls.emitStdoutChunk(
          `${JSON.stringify({ id: 2, error: { message: "read failed" } })}\n`,
        );
        yield* waitForSignalCount(1);
        yield* controls.emitExit(exit());
        const result = yield* Effect.either(Fiber.join(request));
        expect(Either.isLeft(result)).toBe(true);
      }).pipe(
        Effect.provide(
          infrastructureLayer({ exists: new Map([[bunCodex, true]]) }),
        ),
      ),
  );

  it.effect(
    "surfaces process errors and bounds early-exit stderr to its last 500 characters",
    () =>
      Effect.gen(function* () {
        const controls = yield* ProcessServiceTest;
        const processFailure = yield* Effect.fork(readOpenAiRateLimits);
        yield* waitForSpawn;
        yield* controls.emitError(
          new ProcessError({ operation: "spawn", message: "codex broke" }),
        );
        const processResult = yield* Effect.either(Fiber.join(processFailure));
        expect(Either.isLeft(processResult)).toBe(true);
        if (Either.isLeft(processResult)) {
          expect(processResult.left).toBeInstanceOf(ProcessError);
        }

        yield* controls.reset;
        const earlyExit = yield* Effect.fork(readOpenAiRateLimits);
        yield* waitForSpawn;
        yield* controls.emitStderr(`discard${"x".repeat(500)}`);
        yield* Effect.yieldNow();
        yield* controls.emitExit({ code: 7, signal: null });
        const earlyResult = yield* Effect.either(Fiber.join(earlyExit));
        expect(Either.isLeft(earlyResult)).toBe(true);
        if (Either.isLeft(earlyResult)) {
          expect(earlyResult.left).toBeInstanceOf(CodexRateLimitError);
          expect(earlyResult.left).toMatchObject({
            reason: "early-exit",
            stderr: "x".repeat(500),
          });
        }
      }).pipe(
        Effect.provide(
          infrastructureLayer({ exists: new Map([[bunCodex, true]]) }),
        ),
      ),
  );

  it.effect("times out after 20 seconds and cannot hang bounded release", () =>
    Effect.gen(function* () {
      const controls = yield* ProcessServiceTest;
      const request = yield* Effect.fork(readOpenAiRateLimits);
      yield* waitForSpawn;
      yield* waitFor(
        controls.getState.pipe(
          Effect.map((state) => state.stdinWrites.length === 1),
        ),
      );
      yield* Effect.yieldNow();

      yield* TestClock.adjust(Duration.seconds(20));
      yield* waitForSignalCount(1);
      yield* Effect.yieldNow();
      yield* TestClock.adjust(Duration.seconds(1));
      yield* waitForSignalCount(2);
      expect((yield* controls.getState).signals).toEqual([
        "SIGTERM",
        "SIGKILL",
      ]);
      yield* Effect.yieldNow();
      yield* TestClock.adjust(Duration.seconds(1));

      const result = yield* Effect.either(Fiber.join(request));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toMatchObject({ reason: "timeout" });
      }
      expect((yield* controls.getState).stdinEndCount).toBe(1);
    }).pipe(
      Effect.provide(
        infrastructureLayer({ exists: new Map([[bunCodex, true]]) }),
      ),
    ),
  );

  it.effect(
    "frames JSON-RPC across stdout chunks and flushes a final unterminated line",
    () =>
      Effect.gen(function* () {
        const controls = yield* ProcessServiceTest;
        const request = yield* Effect.fork(readOpenAiRateLimits);
        yield* waitForSpawn;

        const initializeSplit = Math.floor(initializeResult.length / 2);
        yield* controls.emitStdoutChunk(
          initializeResult.slice(0, initializeSplit),
        );
        yield* controls.emitStdoutChunk(
          `${initializeResult.slice(initializeSplit)}\nnot json\n`,
        );
        const initialized = yield* waitForYields(
          controls.getState.pipe(
            Effect.map((state) => state.stdinWrites.length === 2),
          ),
        );

        if (!initialized) {
          yield* controls.emitExit({ code: 1, signal: null });
          yield* Effect.either(Fiber.join(request));
          expect(initialized).toBe(true);
          return;
        }

        const rateLimitSplit = Math.floor(rateLimitResult.length / 2);
        yield* controls.emitStdoutChunk(
          rateLimitResult.slice(0, rateLimitSplit),
        );
        yield* controls.emitStdoutChunk(rateLimitResult.slice(rateLimitSplit));
        yield* controls.endStdout;
        yield* waitForSignalCount(1);
        yield* controls.emitExit(exit());

        expect(yield* Fiber.join(request)).toEqual({
          limitId: "codex",
          primary: { usedPercent: 25 },
        });
      }).pipe(
        Effect.provide(
          infrastructureLayer({ exists: new Map([[bunCodex, true]]) }),
        ),
      ),
  );

  it.effect(
    "continues managed cleanup when stdin completion never arrives",
    () =>
      Effect.gen(function* () {
        const controls = yield* ProcessServiceTest;
        const request = yield* Effect.fork(readOpenAiRateLimits);
        yield* waitForSpawn;
        yield* controls.emitStdoutChunk(`${initializeResult}\n`);
        yield* controls.emitStdoutChunk(`${rateLimitResult}\n`);
        yield* waitFor(
          controls.getState.pipe(
            Effect.map((state) => state.stdinEndCount === 1),
          ),
        );

        yield* TestClock.adjust(Duration.millis(100));
        yield* waitForSignalCount(1);
        yield* controls.emitExit(exit());

        expect(yield* Fiber.join(request)).toMatchObject({ limitId: "codex" });
        expect((yield* controls.getState).signals).toEqual(["SIGTERM"]);
      }).pipe(
        Effect.provide(
          infrastructureLayer({
            exists: new Map([[bunCodex, true]]),
            stdinEnd: "never",
          }),
        ),
      ),
  );

  it.effect(
    "closes stdin, interrupts streams, and escalates SIGTERM to SIGKILL",
    () =>
      Effect.gen(function* () {
        const controls = yield* ProcessServiceTest;
        const request = yield* Effect.fork(readOpenAiRateLimits);
        yield* waitForSpawn;
        yield* controls.emitStdoutChunk(`${initializeResult}\n`);
        yield* controls.emitStdoutChunk(`${rateLimitResult}\n`);
        yield* waitForSignalCount(1);

        expect((yield* controls.getState).stdinEndCount).toBe(1);
        yield* Effect.yieldNow();
        yield* TestClock.adjust(Duration.seconds(1));
        yield* waitForSignalCount(2);
        expect((yield* controls.getState).signals).toEqual([
          "SIGTERM",
          "SIGKILL",
        ]);
        yield* controls.emitExit(exit("SIGKILL"));
        expect(yield* Fiber.join(request)).toMatchObject({ limitId: "codex" });
      }).pipe(
        Effect.provide(
          infrastructureLayer({ exists: new Map([[bunCodex, true]]) }),
        ),
      ),
  );

  it.effect("runs bounded cleanup when the caller is interrupted", () =>
    Effect.gen(function* () {
      const controls = yield* ProcessServiceTest;
      const request = yield* Effect.fork(readOpenAiRateLimits);
      yield* waitForSpawn;
      const interruption = yield* Effect.fork(Fiber.interrupt(request));
      yield* waitForSignalCount(1);
      yield* Effect.yieldNow();
      yield* TestClock.adjust(Duration.seconds(1));
      yield* waitForSignalCount(2);
      yield* Effect.yieldNow();
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(interruption);

      const state = yield* controls.getState;
      expect(state.stdinEndCount).toBe(1);
      expect(state.signals).toEqual(["SIGTERM", "SIGKILL"]);
    }).pipe(
      Effect.provide(
        infrastructureLayer({ exists: new Map([[bunCodex, true]]) }),
      ),
    ),
  );
});
