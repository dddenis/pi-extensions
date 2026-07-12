import { describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Stream, TestClock } from "effect";
import { expect } from "vitest";
import { ProcessError, ProcessService } from "../../src/services/process";
import { ProcessServiceTest } from "./process";

const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)));

const terminationConfig = {
  stdinCloseTimeout: Duration.millis(100),
  gracefulTimeout: Duration.seconds(1),
  forcedTimeout: Duration.seconds(1),
  totalTimeout: Duration.millis(2_100),
};

describe("ProcessServiceTest", () => {
  it.effect(
    "records copied calls and process operations and controls output",
    () => {
      const args = ["app-server", "--stdio"];
      const env = { TOKEN: "secret" };

      return Effect.gen(function* () {
        const process = yield* ProcessService;
        const controls = yield* ProcessServiceTest;
        const child = yield* process.spawnScoped(
          "codex",
          args,
          {
            cwd: "/workspace",
            env,
            detached: true,
            stdio: "pipe",
          },
          terminationConfig,
        );
        args.push("mutated");
        env.TOKEN = "mutated";

        const stdout = yield* Effect.fork(collect(child.stdoutLines));
        const stderr = yield* Effect.fork(collect(child.stderrChunks));
        yield* controls.emitStdout("first");
        yield* controls.emitStdout("second");
        yield* controls.emitStderr("warning");
        yield* child.writeStdin("request\n");
        yield* child.endStdin;
        yield* child.unref;
        yield* controls.emitExit({ code: 0, signal: null });

        expect(yield* Fiber.join(stdout)).toEqual(["first", "second"]);
        expect(yield* Fiber.join(stderr)).toEqual(["warning"]);
        expect(yield* child.waitForExit).toEqual({ code: 0, signal: null });
        expect(yield* child.waitForExit).toEqual({ code: 0, signal: null });

        const first = yield* controls.getState;
        const second = yield* controls.getState;
        Object.assign(first.calls[0]?.args ?? [], { 0: "mutated" });
        Object.assign(first.calls[0]?.options.env ?? {}, { TOKEN: "mutated" });
        Object.assign(first.stdinWrites, { 0: "mutated" });
        Object.assign(first.signals, { 0: "SIGKILL" });

        expect(first.calls).not.toBe(second.calls);
        expect(first.stdinWrites).not.toBe(second.stdinWrites);
        expect(first.signals).not.toBe(second.signals);
        expect(second).toEqual({
          calls: [
            {
              command: "codex",
              args: ["app-server", "--stdio"],
              options: {
                cwd: "/workspace",
                env: { TOKEN: "secret" },
                detached: true,
                stdio: "pipe",
              },
            },
          ],
          managedSpawnCount: 1,
          detachedSpawnCount: 0,
          stdinWrites: ["request\n"],
          stdinEndCount: 1,
          signals: [],
          lifecycleEvents: [
            "shutdown-started",
            "stdout-stopped",
            "stderr-stopped",
          ],
          unrefCount: 1,
        });
      }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer()));
    },
  );

  it.effect("replays controlled asynchronous errors", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const child = yield* process.spawnScoped(
        "player",
        [],
        { stdio: "ignore" },
        terminationConfig,
      );
      const error = new ProcessError({
        operation: "spawn",
        message: "player unavailable",
      });

      yield* controls.emitError(error);

      expect(yield* Effect.flip(child.waitForExit)).toEqual(error);
      expect(yield* Effect.flip(child.waitForExit)).toEqual(error);
    }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
  );

  it.effect("does not escalate when the child exits after SIGTERM", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const child = yield* process.spawnScoped(
        "codex",
        [],
        { stdio: "ignore" },
        terminationConfig,
      );
      const cleanup = yield* Effect.fork(child.shutdown);
      yield* Effect.yieldNow();

      yield* controls.emitExit({ code: 0, signal: "SIGTERM" });
      yield* Fiber.join(cleanup);

      expect((yield* controls.getState).signals).toEqual(["SIGTERM"]);
    }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
  );

  it.effect("escalates after the graceful bound", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const child = yield* process.spawnScoped(
        "codex",
        ["app-server", "--stdio"],
        { stdio: "pipe" },
        terminationConfig,
      );
      const cleanup = yield* Effect.fork(child.shutdown);

      yield* TestClock.adjust(Duration.seconds(1));
      expect((yield* controls.getState).signals).toEqual([
        "SIGTERM",
        "SIGKILL",
      ]);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(cleanup);
    }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
  );

  it.effect("cannot hang cleanup when exit never arrives", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const child = yield* process.spawnScoped(
        "codex",
        [],
        { stdio: "ignore" },
        terminationConfig,
      );
      const cleanup = yield* Effect.fork(child.shutdown);

      yield* TestClock.adjust(Duration.seconds(2));
      yield* Fiber.join(cleanup);

      expect((yield* controls.getState).signals).toEqual([
        "SIGTERM",
        "SIGKILL",
      ]);
    }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
  );
});
