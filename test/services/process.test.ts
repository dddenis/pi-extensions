import { describe, it } from "@effect/vitest";
import {
  Chunk,
  Duration,
  Effect,
  Fiber,
  Option,
  Stream,
  TestClock,
} from "effect";
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
    "controls concurrent children by index and snapshots per process state",
    () =>
      Effect.gen(function* () {
        const process = yield* ProcessService;
        const controls = yield* ProcessServiceTest;
        const first = yield* process.spawnScoped(
          "pi",
          ["first"],
          { stdio: "pipe" },
          terminationConfig,
        );
        const second = yield* process.spawnScoped(
          "pi",
          ["second"],
          { stdio: "pipe" },
          terminationConfig,
        );
        const firstStderr = yield* Effect.fork(
          Stream.runCollect(first.stderrChunks),
        );

        yield* controls.emitLaunch(0);
        yield* controls.emitLaunch(1);
        yield* first.awaitLaunch;
        yield* second.awaitLaunch;
        yield* controls.emitStdout(1, "second-line");
        yield* controls.emitStderr(0, "first-warning");

        const firstShutdown = yield* Effect.fork(first.shutdown);
        while ((yield* controls.getState).processes[0]?.signals.length !== 1) {
          yield* Effect.yieldNow();
        }

        yield* controls.complete(0, { code: 0, signal: "SIGTERM" });
        yield* controls.complete(1, { code: 0, signal: null });

        expect(yield* Stream.runCollect(second.stdoutLines)).toEqual(
          Chunk.of("second-line"),
        );
        expect(yield* Fiber.join(firstStderr)).toEqual(
          Chunk.of("first-warning"),
        );
        expect(yield* first.waitForExit).toEqual({
          code: 0,
          signal: "SIGTERM",
        });
        expect(yield* second.waitForExit).toEqual({ code: 0, signal: null });
        yield* Fiber.join(firstShutdown);

        const firstState = yield* controls.getState;
        const secondState = yield* controls.getState;
        Object.assign(firstState.processes[0]?.args ?? [], { 0: "mutated" });
        Object.assign(firstState.processes[0]?.signals ?? [], {
          0: "SIGKILL",
        });

        expect(firstState.processes).not.toBe(secondState.processes);
        expect(firstState.processes[0]?.args).not.toBe(
          secondState.processes[0]?.args,
        );
        expect(firstState.processes[0]?.signals).not.toBe(
          secondState.processes[0]?.signals,
        );
        expect(secondState.processes).toHaveLength(2);
        expect(secondState.processes[0]).toMatchObject({
          command: "pi",
          args: ["first"],
          options: { stdio: "pipe" },
          signals: ["SIGTERM"],
        });
        expect(secondState.processes[1]).toMatchObject({
          command: "pi",
          args: ["second"],
          options: { stdio: "pipe" },
          signals: [],
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(ProcessServiceTest.layer({ manualLaunch: true })),
      ),
  );

  it.effect("unrefs a detached child when pending launch is interrupted", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const detached = yield* Effect.fork(
        process.spawnDetached("pi", ["child"], {}),
      );

      while ((yield* controls.getState).processes.length !== 1) {
        yield* Effect.yieldNow();
      }
      const pending = yield* controls.getState;
      expect(Option.isNone(yield* Fiber.poll(detached))).toBe(true);
      expect(pending.unrefCount).toBe(0);
      expect(pending.processes[0]?.unrefCount).toBe(0);

      yield* Fiber.interrupt(detached);

      const interrupted = yield* controls.getState;
      expect(interrupted.detachedSpawnCount).toBe(1);
      expect(interrupted.unrefCount).toBe(1);
      expect(interrupted.processes[0]?.unrefCount).toBe(1);
    }).pipe(Effect.provide(ProcessServiceTest.layer({ manualLaunch: true }))),
  );

  it.effect("replays indexed launch failures through launch and exit", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const first = yield* process.spawnScoped(
        "pi",
        ["first"],
        { stdio: "ignore" },
        terminationConfig,
      );
      const second = yield* process.spawnScoped(
        "pi",
        ["second"],
        { stdio: "ignore" },
        terminationConfig,
      );
      const error = new ProcessError({
        operation: "spawn",
        message: "spawn failed",
      });

      yield* controls.emitLaunch(0);
      yield* controls.emitLaunchFailure(1, error);
      yield* first.awaitLaunch;

      const launchError = yield* Effect.flip(second.awaitLaunch);
      const exitError = yield* Effect.flip(second.waitForExit);
      expect(launchError).toBe(exitError);
      expect(exitError).toEqual(error);

      yield* controls.complete(0, { code: 0, signal: null });
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessServiceTest.layer({ manualLaunch: true })),
    ),
  );

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
        yield* controls.emitStdout(0, "first");
        yield* controls.emitStdout(0, "second");
        yield* controls.emitStderr(0, "warning");
        yield* child.writeStdin("request\n");
        yield* child.endStdin;
        yield* child.unref;
        yield* controls.complete(0, { code: 0, signal: null });

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
          outputCloseCount: 0,
          unrefCount: 1,
          processes: [
            {
              command: "codex",
              args: ["app-server", "--stdio"],
              options: {
                cwd: "/workspace",
                env: { TOKEN: "secret" },
                detached: true,
                stdio: "pipe",
              },
              stdinWrites: ["request\n"],
              stdinEndCount: 1,
              signals: [],
              lifecycleEvents: [
                "shutdown-started",
                "stdout-stopped",
                "stderr-stopped",
              ],
              outputCloseCount: 0,
              unrefCount: 1,
            },
          ],
        });
      }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer()));
    },
  );

  it.effect(
    "models direct exit independently from output EOF and closes output idempotently",
    () =>
      Effect.gen(function* () {
        const process = yield* ProcessService;
        const controls = yield* ProcessServiceTest;
        const child = yield* process.spawnScoped(
          "pi",
          [],
          { stdio: "pipe" },
          terminationConfig,
        );
        const stdout = yield* Effect.fork(collect(child.stdoutLines));
        const stderr = yield* Effect.fork(collect(child.stderrChunks));

        yield* controls.emitExit(0, { code: 0, signal: null });
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(stdout))).toBe(true);
        expect(Option.isNone(yield* Fiber.poll(stderr))).toBe(true);
        yield* controls.emitStdout(0, "tail");
        yield* child.closeOutput;
        yield* child.closeOutput;

        expect(yield* Fiber.join(stdout)).toEqual(["tail"]);
        expect(yield* Fiber.join(stderr)).toEqual([]);
        expect(yield* child.waitForExit).toEqual({ code: 0, signal: null });
        expect((yield* controls.getState).outputCloseCount).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
  );

  it.effect("replays closed output to late collectors", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const child = yield* process.spawnScoped(
        "closed-output",
        [],
        { stdio: "pipe" },
        terminationConfig,
      );

      yield* controls.emitExit(0, { code: 0, signal: null });
      yield* child.closeOutput;

      expect(yield* collect(child.stdoutLines)).toEqual([]);
      expect(yield* collect(child.stderrChunks)).toEqual([]);
      expect(yield* collect(child.stdoutLines)).toEqual([]);
      expect(yield* collect(child.stderrChunks)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
  );

  it.effect("replays output failures to late collectors", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const child = yield* process.spawnScoped(
        "failed-output",
        [],
        { stdio: "pipe" },
        terminationConfig,
      );
      const failure = new ProcessError({
        operation: "stream",
        message: "read failed",
      });

      yield* controls.emitError(0, failure);

      expect(yield* Effect.flip(collect(child.stdoutLines))).toEqual(failure);
      expect(yield* Effect.flip(collect(child.stderrChunks))).toEqual(failure);
      expect(yield* Effect.flip(collect(child.stdoutLines))).toEqual(failure);
      expect(yield* Effect.flip(collect(child.stderrChunks))).toEqual(failure);
    }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
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

      yield* controls.emitError(0, error);

      expect(yield* Effect.flip(child.waitForExit)).toEqual(error);
      expect(yield* Effect.flip(child.waitForExit)).toEqual(error);
    }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
  );

  it.effect(
    "records indexed post-launch errors without replacing streams or exit",
    () =>
      Effect.gen(function* () {
        const process = yield* ProcessService;
        const controls = yield* ProcessServiceTest;
        const child = yield* process.spawnScoped(
          "pi",
          [],
          { stdio: "pipe" },
          terminationConfig,
        );
        const stdout = yield* Effect.fork(collect(child.stdoutLines));
        const error = new ProcessError({
          operation: "wait",
          message: "late process error",
        });

        yield* controls.emitPostLaunchError(0, error);
        yield* controls.emitStdout(0, "completion");
        yield* controls.complete(0, { code: 0, signal: null });

        expect(yield* Fiber.join(stdout)).toEqual(["completion"]);
        expect(yield* child.waitForExit).toEqual({ code: 0, signal: null });
        expect((yield* child.shutdown).processErrors).toEqual([error]);
      }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
  );

  it.effect("rejects writes when stdin is ignored without recording them", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const child = yield* process.spawnScoped(
        "pi",
        [],
        { stdio: "ignore" },
        terminationConfig,
      );

      expect(yield* Effect.flip(child.writeStdin("request\n"))).toEqual(
        new ProcessError({
          operation: "stdin",
          message:
            "stdin is unavailable for a process spawned with ignored stdio",
        }),
      );
      const state = yield* controls.getState;
      expect(state.stdinWrites).toEqual([]);
      expect(state.processes[0]?.stdinWrites).toEqual([]);

      yield* controls.complete(0, { code: 0, signal: null });
    }).pipe(Effect.scoped, Effect.provide(ProcessServiceTest.layer())),
  );

  it.effect("reports ignored stdin as unavailable during shutdown", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const child = yield* process.spawnScoped(
        "pi",
        [],
        { stdio: "ignore" },
        terminationConfig,
      );

      yield* controls.complete(0, { code: 0, signal: null });

      expect((yield* child.shutdown).stdin).toEqual({ _tag: "Unavailable" });
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
      while ((yield* controls.getState).signals.length === 0) {
        yield* Effect.yieldNow();
      }

      yield* controls.complete(0, { code: 0, signal: "SIGTERM" });
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

  it.effect("abandons local handles when cleanup cannot confirm exit", () =>
    Effect.gen(function* () {
      const process = yield* ProcessService;
      const controls = yield* ProcessServiceTest;
      const child = yield* process.spawnScoped(
        "never-terminal",
        [],
        { stdio: "pipe" },
        terminationConfig,
      );
      const cleanup = yield* Effect.fork(child.shutdown);

      yield* TestClock.adjust(Duration.seconds(2));
      const report = yield* Fiber.join(cleanup);

      expect(report).toMatchObject({ terminalUnconfirmed: true });
      expect(yield* child.shutdown).toBe(report);
      expect(yield* collect(child.stdoutLines)).toEqual([]);
      expect(yield* collect(child.stderrChunks)).toEqual([]);
      expect(yield* controls.getState).toMatchObject({
        outputCloseCount: 1,
        unrefCount: 1,
        processes: [{ outputCloseCount: 1, unrefCount: 1 }],
      });
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
