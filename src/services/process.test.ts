import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Stream,
  TestClock,
} from "effect";
import { afterEach, expect, vi } from "vitest";
import { ProcessError, ProcessService } from "./process";

const spawnOverride = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: ReadonlyArray<string>,
      options: SpawnOptions,
    ) => {
      const overridden = spawnOverride(command, args, options);
      return overridden ?? actual.spawn(command, [...args], options);
    },
  };
});

const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)));

const shutdownPolicy = {
  stdinCloseTimeout: Duration.millis(100),
  gracefulTimeout: Duration.seconds(1),
  forcedTimeout: Duration.seconds(1),
  totalTimeout: Duration.millis(2_100),
};

afterEach(() => {
  spawnOverride.mockReset();
});

describe("ProcessService.Live", () => {
  it.effect(
    "owns an immediate process error before acquisition can be interrupted",
    () => {
      const events = new EventEmitter();
      const child = Object.assign(events, {
        stdin: null,
        stdout: null,
        stderr: null,
        kill: () => true,
        unref: () => undefined,
      });
      let resolveOwned: (owned: boolean) => void = () => undefined;
      const errorWasOwned = new Promise<boolean>((resolve) => {
        resolveOwned = resolve;
      });
      spawnOverride.mockImplementationOnce(() => {
        queueMicrotask(() => {
          const owned = child.listenerCount("error") > 0;
          if (owned) {
            child.emit("error", new Error("immediate spawn failure"));
          }
          resolveOwned(owned);
        });
        return child;
      });

      return Effect.gen(function* () {
        const processes = yield* ProcessService;
        const spawned = yield* processes
          .spawnScoped(
            "immediate-error",
            [],
            { stdio: "ignore" },
            shutdownPolicy,
          )
          .pipe(Effect.withMaxOpsBeforeYield(10));

        expect(yield* Effect.promise(() => errorWasOwned)).toBe(true);
        const error = yield* Effect.flip(spawned.waitForExit);
        expect(error).toMatchObject({
          _tag: "ProcessError",
          operation: "spawn",
          message: "immediate spawn failure",
        });
      }).pipe(Effect.scoped, Effect.provide(ProcessService.Live));
    },
  );

  it.effect("backpressures stderr after its sixteen-chunk buffer fills", () => {
    const events = new EventEmitter();
    const stderr = new PassThrough();
    const child = Object.assign(events, {
      stdin: null,
      stdout: null,
      stderr,
      kill: () => true,
      unref: () => undefined,
    });
    spawnOverride.mockReturnValueOnce(child);

    return Effect.gen(function* () {
      const processes = yield* ProcessService;
      const spawned = yield* processes.spawnScoped(
        "bursty-stderr",
        [],
        { stdio: "pipe" },
        shutdownPolicy,
      );
      const firstChunk = yield* Deferred.make<void>();
      const releaseConsumer = yield* Deferred.make<void>();
      const received: Array<string> = [];
      const consumer = yield* Effect.fork(
        Stream.runForEach(spawned.stderrChunks, (chunk) =>
          Effect.gen(function* () {
            received.push(chunk);
            if (received.length === 1) {
              yield* Deferred.succeed(firstChunk, undefined);
              yield* Deferred.await(releaseConsumer);
            }
          }),
        ),
      );

      stderr.write("0");
      yield* Deferred.await(firstChunk);
      for (let index = 1; index < 17; index += 1) {
        stderr.write(String(index).padStart(2, "0"));
      }
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
      expect(stderr.isPaused()).toBe(false);

      stderr.write("17");
      stderr.end();
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
      expect(stderr.isPaused()).toBe(true);
      expect(received).toEqual(["0"]);

      yield* Deferred.succeed(releaseConsumer, undefined);
      yield* Fiber.join(consumer);
      expect(received.join("")).toBe(
        `0${Array.from({ length: 17 }, (_, index) =>
          String(index + 1).padStart(2, "0"),
        ).join("")}`,
      );
      events.emit("exit", 0, null);
    }).pipe(Effect.scoped, Effect.provide(ProcessService.Live));
  });

  it.effect(
    "bounds stdin completion before escalating managed shutdown",
    () => {
      const events = new EventEmitter();
      const stdinEvents = new EventEmitter();
      const stdin = Object.assign(stdinEvents, {
        write: (_value: string, _encoding: string, complete: () => void) => {
          complete();
          return true;
        },
        end: (_complete: (error?: Error | null) => void) => stdin,
      });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const signals: Array<NodeJS.Signals> = [];
      const child = Object.assign(events, {
        stdin,
        stdout,
        stderr,
        kill: (signal: NodeJS.Signals) => {
          signals.push(signal);
          return true;
        },
        unref: () => undefined,
      });
      spawnOverride.mockReturnValueOnce(child);

      return Effect.gen(function* () {
        const processes = yield* ProcessService;
        const managed = yield* processes.spawnScoped(
          "stalled-stdin",
          [],
          { stdio: "pipe" },
          {
            stdinCloseTimeout: Duration.millis(100),
            gracefulTimeout: Duration.seconds(1),
            forcedTimeout: Duration.seconds(1),
            totalTimeout: Duration.millis(2_100),
          },
        );
        const shutdown = yield* Effect.fork(managed.shutdown);
        const follower = yield* Effect.fork(managed.shutdown);

        yield* TestClock.adjust(Duration.millis(100));
        expect(signals).toEqual(["SIGTERM"]);
        yield* TestClock.adjust(Duration.seconds(1));
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        yield* TestClock.adjust(Duration.seconds(1));

        const leaderReport = yield* Fiber.join(shutdown);
        const followerReport = yield* Fiber.join(follower);
        const replayedReport = yield* managed.shutdown;
        expect(leaderReport).toMatchObject({
          stdin: { _tag: "TimedOut" },
          signalsAttempted: ["SIGTERM", "SIGKILL"],
          terminalUnconfirmed: true,
          deadlineExceeded: true,
        });
        expect(followerReport).toBe(leaderReport);
        expect(replayedReport).toBe(leaderReport);
      }).pipe(Effect.scoped, Effect.provide(ProcessService.Live));
    },
  );

  it.effect("caps all shutdown phases with a shorter total deadline", () => {
    const events = new EventEmitter();
    const stdinEvents = new EventEmitter();
    const stdin = Object.assign(stdinEvents, {
      write: (_value: string, _encoding: string, complete: () => void) => {
        complete();
        return true;
      },
      end: (_complete: (error?: Error | null) => void) => stdin,
      destroy: () => stdin,
    });
    const signals: Array<NodeJS.Signals> = [];
    const child = Object.assign(events, {
      pid: 123,
      stdin,
      stdout: null,
      stderr: null,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        return true;
      },
      unref: () => undefined,
    });
    spawnOverride.mockReturnValueOnce(child);

    return Effect.gen(function* () {
      const processes = yield* ProcessService;
      const managed = yield* processes.spawnScoped(
        "short-total-deadline",
        [],
        { stdio: "pipe" },
        {
          stdinCloseTimeout: Duration.seconds(10),
          gracefulTimeout: Duration.seconds(10),
          forcedTimeout: Duration.seconds(10),
          totalTimeout: Duration.millis(500),
        },
      );
      const shutdown = yield* Effect.fork(managed.shutdown);

      yield* TestClock.adjust(Duration.millis(500));
      expect(yield* Fiber.join(shutdown)).toMatchObject({
        signalsAttempted: ["SIGTERM", "SIGKILL"],
        terminalUnconfirmed: true,
        deadlineExceeded: true,
      });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    }).pipe(Effect.scoped, Effect.provide(ProcessService.Live));
  });

  it.effect(
    "reports ignored stdin as unavailable during managed shutdown",
    () => {
      const events = new EventEmitter();
      const child = Object.assign(events, {
        stdin: null,
        stdout: null,
        stderr: null,
        kill: (signal: NodeJS.Signals) => {
          queueMicrotask(() => events.emit("exit", 0, signal));
          return true;
        },
        unref: () => undefined,
      });
      spawnOverride.mockReturnValueOnce(child);

      return Effect.gen(function* () {
        const processes = yield* ProcessService;
        const managed = yield* processes.spawnScoped(
          "ignored-stdin",
          [],
          { stdio: "ignore" },
          shutdownPolicy,
        );

        expect(yield* managed.shutdown).toMatchObject({
          stdin: { _tag: "Unavailable" },
          signalsAttempted: ["SIGTERM"],
          deadlineExceeded: false,
        });
      }).pipe(Effect.scoped, Effect.provide(ProcessService.Live));
    },
  );

  it.effect("owns shutdown automatically when the managed scope closes", () => {
    const events = new EventEmitter();
    const signals: Array<NodeJS.Signals> = [];
    let stdinEndCount = 0;
    const stdinEvents = new EventEmitter();
    const stdin = Object.assign(stdinEvents, {
      write: (_value: string, _encoding: string, complete: () => void) => {
        complete();
        return true;
      },
      end: (complete: (error?: Error | null) => void) => {
        stdinEndCount += 1;
        complete();
        return stdin;
      },
      destroy: () => stdin,
    });
    const child = Object.assign(events, {
      pid: 123,
      stdin,
      stdout: null,
      stderr: null,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        queueMicrotask(() => events.emit("exit", 0, signal));
        return true;
      },
      unref: () => undefined,
    });
    spawnOverride.mockReturnValueOnce(child);

    return Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ProcessService;
        yield* processes.spawnScoped(
          "scope-owned",
          [],
          { stdio: "pipe" },
          shutdownPolicy,
        );
      }),
    ).pipe(
      Effect.zipRight(
        Effect.sync(() => {
          expect(stdinEndCount).toBe(1);
          expect(signals).toEqual(["SIGTERM"]);
        }),
      ),
      Effect.provide(ProcessService.Live),
    );
  });

  it.effect("skips shutdown operations after a terminal result", () => {
    const events = new EventEmitter();
    const signals: Array<NodeJS.Signals> = [];
    const child = Object.assign(events, {
      pid: 123,
      stdin: null,
      stdout: null,
      stderr: null,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        return true;
      },
      unref: () => undefined,
    });
    spawnOverride.mockReturnValueOnce(child);

    return Effect.gen(function* () {
      const processes = yield* ProcessService;
      const managed = yield* processes.spawnScoped(
        "already-terminal",
        [],
        { stdio: "ignore" },
        shutdownPolicy,
      );
      events.emit("exit", 0, null);
      yield* Effect.yieldNow();

      expect(yield* managed.shutdown).toMatchObject({
        signalsAttempted: [],
        terminal: { _tag: "Exited", exit: { code: 0, signal: null } },
        terminalUnconfirmed: false,
      });
      expect(signals).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcessService.Live));
  });

  it.effect(
    "cannot interrupt EOF initiation after ownership is claimed",
    () => {
      const events = new EventEmitter();
      const stdinEvents = new EventEmitter();
      let endCount = 0;
      const stdin = Object.assign(stdinEvents, {
        write: (_value: string, _encoding: string, complete: () => void) => {
          complete();
          return true;
        },
        end: (complete: (error?: Error | null) => void) => {
          endCount += 1;
          complete();
          return stdin;
        },
        destroy: () => stdin,
      });
      const child = Object.assign(events, {
        pid: 123,
        stdin,
        stdout: null,
        stderr: null,
        kill: (signal: NodeJS.Signals) => {
          queueMicrotask(() => events.emit("exit", 0, signal));
          return true;
        },
        unref: () => undefined,
      });
      spawnOverride.mockReturnValueOnce(child);

      return Effect.gen(function* () {
        const processes = yield* ProcessService;
        const managed = yield* processes.spawnScoped(
          "interrupt-eof",
          [],
          { stdio: "pipe" },
          shutdownPolicy,
        );
        const request = yield* Effect.fork(
          managed.requestStdinEnd.pipe(Effect.withMaxOpsBeforeYield(1)),
        );
        yield* Fiber.interrupt(request);
        yield* managed.requestStdinEnd;
        yield* managed.awaitStdinEnd;

        expect(endCount).toBe(1);
        events.emit("exit", 0, null);
      }).pipe(Effect.scoped, Effect.provide(ProcessService.Live));
    },
  );

  it.effect(
    "keeps waiting and escalates after a post-spawn process error",
    () => {
      const events = new EventEmitter();
      const signals: Array<NodeJS.Signals> = [];
      const child = Object.assign(events, {
        pid: 123,
        stdin: null,
        stdout: null,
        stderr: null,
        kill: (signal: NodeJS.Signals) => {
          signals.push(signal);
          if (signal === "SIGTERM") {
            queueMicrotask(() =>
              events.emit("error", new Error("kill delivery failed")),
            );
          } else {
            queueMicrotask(() => events.emit("exit", 0, signal));
          }
          return true;
        },
        unref: () => undefined,
      });
      spawnOverride.mockReturnValueOnce(child);

      return Effect.gen(function* () {
        const processes = yield* ProcessService;
        const managed = yield* processes.spawnScoped(
          "post-spawn-error",
          [],
          { stdio: "ignore" },
          shutdownPolicy,
        );
        const shutdown = yield* Effect.fork(managed.shutdown);
        yield* Effect.yieldNow();
        yield* TestClock.adjust(Duration.seconds(1));

        expect(yield* Fiber.join(shutdown)).toMatchObject({
          signalsAttempted: ["SIGTERM", "SIGKILL"],
          signalErrors: [
            { operation: "kill", message: "kill delivery failed" },
          ],
          processErrors: [
            { operation: "kill", message: "kill delivery failed" },
          ],
          terminal: {
            _tag: "Exited",
            exit: { code: 0, signal: "SIGKILL" },
          },
          terminalUnconfirmed: false,
        });
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      }).pipe(Effect.scoped, Effect.provide(ProcessService.Live));
    },
  );

  it.effect(
    "acknowledges launch before detaching without waiting for exit",
    () => {
      const events = new EventEmitter();
      let unrefCount = 0;
      const child = Object.assign(events, {
        stdin: null,
        stdout: null,
        stderr: null,
        kill: () => true,
        unref: () => {
          unrefCount += 1;
        },
      });
      spawnOverride.mockReturnValueOnce(child);

      return Effect.gen(function* () {
        const processes = yield* ProcessService;
        const detached = yield* Effect.fork(
          processes.spawnDetached("afplay", ["sound.mp3"], {}),
        );
        yield* Effect.yieldNow();

        expect(spawnOverride).toHaveBeenCalledWith("afplay", ["sound.mp3"], {
          cwd: undefined,
          env: undefined,
          detached: true,
          stdio: "ignore",
        });
        expect(Option.isNone(yield* Fiber.poll(detached))).toBe(true);
        expect(unrefCount).toBe(0);

        events.emit("spawn");
        yield* Fiber.join(detached);

        expect(unrefCount).toBe(1);
      }).pipe(Effect.provide(ProcessService.Live));
    },
  );

  it.effect(
    "unreferences a detached child when launch waiting is interrupted",
    () => {
      const events = new EventEmitter();
      let unrefCount = 0;
      const child = Object.assign(events, {
        stdin: null,
        stdout: null,
        stderr: null,
        kill: () => true,
        unref: () => {
          unrefCount += 1;
        },
      });
      spawnOverride.mockReturnValueOnce(child);

      return Effect.gen(function* () {
        const processes = yield* ProcessService;
        const detached = yield* Effect.fork(
          processes.spawnDetached("interrupted-launch", [], {}),
        );
        yield* Effect.yieldNow();

        expect(Option.isNone(yield* Fiber.poll(detached))).toBe(true);
        yield* Fiber.interrupt(detached);
        expect(unrefCount).toBe(1);

        expect(() =>
          events.emit("error", new Error("late launch failure")),
        ).not.toThrow();
      }).pipe(Effect.provide(ProcessService.Live));
    },
  );

  it.effect("fails detached acquisition when the command cannot spawn", () =>
    Effect.gen(function* () {
      const processes = yield* ProcessService;
      const error = yield* Effect.flip(
        processes.spawnDetached(
          "pi-extensions-detached-command-that-cannot-exist",
          [],
          {},
        ),
      );

      expect(error).toBeInstanceOf(ProcessError);
      expect(error.operation).toBe("spawn");
    }).pipe(Effect.provide(ProcessService.Live)),
  );

  it.effect("owns an immediate detached spawn error before returning", () => {
    const events = new EventEmitter();
    let unrefCount = 0;
    const child = Object.assign(events, {
      stdin: null,
      stdout: null,
      stderr: null,
      kill: () => true,
      unref: () => {
        unrefCount += 1;
      },
    });
    spawnOverride.mockImplementationOnce(() => {
      queueMicrotask(() => events.emit("error", new Error("spawn failed")));
      return child;
    });

    return Effect.gen(function* () {
      const processes = yield* ProcessService;
      const error = yield* Effect.flip(
        processes.spawnDetached("immediate-error", [], {}),
      );

      expect(error).toMatchObject({
        _tag: "ProcessError",
        operation: "spawn",
        message: "spawn failed",
      });
      expect(unrefCount).toBe(0);
    }).pipe(Effect.provide(ProcessService.Live));
  });

  it.effect(
    "reports detached unref failures through the typed contract",
    () => {
      const events = new EventEmitter();
      const child = Object.assign(events, {
        stdin: null,
        stdout: null,
        stderr: null,
        kill: () => true,
        unref: () => {
          throw new Error("unref failed");
        },
      });
      spawnOverride.mockImplementationOnce(() => {
        queueMicrotask(() => events.emit("spawn"));
        return child;
      });

      return Effect.gen(function* () {
        const processes = yield* ProcessService;
        const error = yield* Effect.flip(
          processes.spawnDetached("unref-failure", [], {}),
        );

        expect(error).toMatchObject({
          _tag: "ProcessError",
          operation: "unref",
          message: "unref failed",
        });
      }).pipe(Effect.provide(ProcessService.Live));
    },
  );

  it.effect(
    "writes stdin, frames stdout by LF, streams stderr, and replays exit",
    () => {
      const script = [
        "process.stdin.setEncoding('utf8')",
        "let input = ''",
        "process.stdin.on('data', chunk => { input += chunk })",
        "process.stdin.on('end', () => {",
        "  process.stdout.write('first\\nsecond\\n')",
        "  process.stdout.write('tail')",
        "  process.stderr.write('problem')",
        "  process.stdout.write(':' + input + '\\n')",
        "})",
      ].join(";");

      return Effect.gen(function* () {
        const processes = yield* ProcessService;
        const child = yield* processes.spawnScoped(
          process.execPath,
          ["-e", script],
          { stdio: "pipe" },
          shutdownPolicy,
        );
        const stdout = yield* Effect.fork(collect(child.stdoutLines));
        const stderr = yield* Effect.fork(collect(child.stderrChunks));

        yield* child.writeStdin("input");
        yield* child.endStdin;

        expect(yield* child.waitForExit).toEqual({ code: 0, signal: null });
        expect(yield* child.waitForExit).toEqual({ code: 0, signal: null });
        expect(yield* Fiber.join(stdout)).toEqual([
          "first",
          "second",
          "tail:input",
        ]);
        expect((yield* Fiber.join(stderr)).join("")).toBe("problem");
      }).pipe(Effect.scoped, Effect.provide(ProcessService.Live));
    },
  );

  it.effect(
    "turns asynchronous spawn errors into a replayable wait failure",
    () =>
      Effect.gen(function* () {
        const processes = yield* ProcessService;
        const child = yield* processes.spawnScoped(
          "pi-extensions-command-that-does-not-exist",
          [],
          { stdio: "ignore" },
          shutdownPolicy,
        );

        const first = yield* Effect.flip(child.waitForExit);
        const second = yield* Effect.flip(child.waitForExit);
        expect(first).toBeInstanceOf(ProcessError);
        expect(first.operation).toBe("spawn");
        expect(second).toEqual(first);
        expect(yield* collect(child.stdoutLines)).toEqual([]);
        expect(yield* collect(child.stderrChunks)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(ProcessService.Live)),
  );
});
