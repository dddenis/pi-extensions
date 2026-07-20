import { Buffer } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Deferred, Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeEffectRunner } from "../lib/effect-runtime";
import {
  type ManagedProcess,
  ProcessError,
  type ProcessExit,
  type ProcessService as ProcessServiceShape,
  type ProcessShutdownReport,
  ProcessService,
} from "../services/process";
import type { ChildCommand } from "./child-command";
import {
  executeBatch,
  type ExecuteBatchInput,
  type SubagentTask,
} from "./execution";
import type { SubagentTaskResult } from "./output";

const fixtureCommand = (): ChildCommand => ({
  command: process.execPath,
  args: [
    fileURLToPath(
      new URL("../../test/fixtures/subagent-child.ts", import.meta.url),
    ),
  ],
});

const withTempDirectory = async <A>(
  use: (directory: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-execution-"));
  try {
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const resultAt = (
  results: ReadonlyArray<SubagentTaskResult>,
  index: number,
): SubagentTaskResult => {
  const result = results[index];
  if (result === undefined) {
    throw new Error(`expected a result at index ${String(index)}`);
  }
  return result;
};

const logicalLineCount = (text: string): number => {
  if (text === "") return 0;
  let lineFeeds = 0;
  for (const character of text) {
    if (character === "\n") lineFeeds += 1;
  }
  return lineFeeds + (text.endsWith("\n") ? 0 : 1);
};

const expectBoundedCapture = (text: string): void => {
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1_024);
  expect(logicalLineCount(text)).toBeLessThanOrEqual(2_000);
};

const makeSemaphore = (permits = 3): Promise<Effect.Semaphore> =>
  Effect.runPromise(Effect.makeSemaphore(permits));

const liveBatch = (input: ExecuteBatchInput) =>
  Effect.runPromise(
    executeBatch(input).pipe(Effect.provide(ProcessService.Live)),
  );

const markerNames = async (directory: string): Promise<ReadonlyArray<string>> =>
  (await readdir(directory)).sort();

const waitForMarkerCount = async (
  directory: string,
  expected: number,
): Promise<ReadonlyArray<string>> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const names = await markerNames(directory);
    if (names.length === expected) return names;
    if (names.length > expected) {
      throw new Error(
        `expected at most ${String(expected)} markers, observed ${String(names.length)}`,
      );
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${String(expected)} markers`);
};

const expectStableMarkerCount = async (
  directory: string,
  expected: number,
  durationMs: number,
): Promise<void> => {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    expect((await markerNames(directory)).length).toBe(expected);
    await delay(10);
  }
};

describe("subagent batch execution with the live Process Service", () => {
  it("writes the prompt once without rewriting bytes", async () => {
    await withTempDirectory(async (directory) => {
      const capturePath = join(directory, "captured-stdin.txt");
      const prompt =
        " \n" +
        JSON.stringify({
          taskId: "exact",
          capturePath,
          stdout: ["done"],
        }) +
        "\n ";
      const semaphore = await makeSemaphore();

      const results = await liveBatch({
        tasks: [{ description: "not child input", prompt }],
        parentCwd: directory,
        command: fixtureCommand(),
        semaphore,
      });

      expect(await readFile(capturePath, "utf8")).toBe(prompt);
      expect(await readFile(capturePath, "utf8")).not.toContain(
        "not child input",
      );
      expect(resultAt(results, 0).status).toBe("completed");
    });
  });

  it("resolves default and relative cwd before scheduling", async () => {
    await withTempDirectory(async (directory) => {
      await mkdir(join(directory, "nested"));
      const semaphore = await makeSemaphore();
      const results = await liveBatch({
        tasks: [
          {
            description: "default cwd",
            prompt: JSON.stringify({ stdout: ["default"] }),
          },
          {
            description: "relative cwd",
            prompt: JSON.stringify({ stdout: ["nested"] }),
            cwd: "nested",
          },
        ],
        parentCwd: directory,
        command: fixtureCommand(),
        semaphore,
      });

      expect(results.map((result) => result.cwd)).toEqual([
        resolve(directory),
        resolve(directory, "nested"),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        "completed",
        "completed",
      ]);
    });
  });

  it("accepts clean empty stdout", async () => {
    await withTempDirectory(async (directory) => {
      const semaphore = await makeSemaphore();
      const results = await liveBatch({
        tasks: [
          {
            description: "quiet",
            prompt: JSON.stringify({ exitCode: 0 }),
          },
        ],
        parentCwd: directory,
        command: fixtureCommand(),
        semaphore,
      });
      const result = resultAt(results, 0);

      expect(result).toMatchObject({
        status: "completed",
        output: "",
        exitCode: 0,
        signal: null,
      });
    });
  });

  it("preserves request order", async () => {
    await withTempDirectory(async (directory) => {
      const semaphore = await makeSemaphore();
      const tasks: ReadonlyArray<SubagentTask> = [
        {
          description: "first",
          prompt: JSON.stringify({ stdout: ["first"], delayMs: 80 }),
        },
        {
          description: "second",
          prompt: JSON.stringify({ stdout: ["second"], delayMs: 10 }),
        },
        {
          description: "third",
          prompt: JSON.stringify({ stdout: ["third"], delayMs: 40 }),
        },
      ];

      const results = await liveBatch({
        tasks,
        parentCwd: directory,
        command: fixtureCommand(),
        semaphore,
      });

      expect(results.map((result) => result.description)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });
  });

  it("isolates nonexistent cwd", async () => {
    await withTempDirectory(async (directory) => {
      const semaphore = await makeSemaphore();
      const results = await liveBatch({
        tasks: [
          {
            description: "missing cwd",
            prompt: JSON.stringify({ stdout: ["unreachable"] }),
            cwd: "missing",
          },
          {
            description: "valid sibling",
            prompt: JSON.stringify({ stdout: ["sibling"] }),
          },
        ],
        parentCwd: directory,
        command: fixtureCommand(),
        semaphore,
      });

      const failed = resultAt(results, 0);
      expect(failed.status).toBe("failed");
      expect(failed.stderr).toContain("[spawn]");
      expect(failed.stderr).toContain("ENOENT");
      expect(resultAt(results, 1).status).toBe("completed");
    });
  });

  it("isolates exit and signal failures", async () => {
    await withTempDirectory(async (directory) => {
      const semaphore = await makeSemaphore();
      const results = await liveBatch({
        tasks: [
          {
            description: "nonzero",
            prompt: JSON.stringify({ exitCode: 7 }),
          },
          {
            description: "signaled",
            prompt: JSON.stringify({ signal: "SIGTERM" }),
          },
          {
            description: "success",
            prompt: JSON.stringify({ stdout: ["done"], exitCode: 0 }),
          },
        ],
        parentCwd: directory,
        command: fixtureCommand(),
        semaphore,
      });

      expect(results.map((result) => result.status)).toEqual([
        "failed",
        "failed",
        "completed",
      ]);
      expect(resultAt(results, 0)).toMatchObject({
        exitCode: 7,
        signal: null,
      });
      expect(resultAt(results, 1)).toMatchObject({
        exitCode: null,
        signal: "SIGTERM",
      });
      expect(resultAt(results, 2)).toMatchObject({
        exitCode: 0,
        signal: null,
      });
    });
  });

  it("drains beyond retention", async () => {
    await withTempDirectory(async (directory) => {
      const semaphore = await makeSemaphore();
      const chunk = "x".repeat(1_024) + "\n";
      const results = await liveBatch({
        tasks: [
          {
            description: "large output",
            prompt: JSON.stringify({
              stdout: [chunk],
              stderr: [chunk],
              stdoutRepeat: 2_048,
              stderrRepeat: 2_048,
            }),
          },
        ],
        parentCwd: directory,
        command: fixtureCommand(),
        semaphore,
      });
      const result = resultAt(results, 0);
      const stderr = result.stderr ?? "";

      expect(result.status).toBe("completed");
      expectBoundedCapture(result.output);
      expectBoundedCapture(stderr);
      expect(result.output).toContain("omitted");
      expect(stderr).toContain("omitted");
    });
  }, 10_000);

  it("bounds large newline-free stdout delivered in chunks", async () => {
    await withTempDirectory(async (directory) => {
      const semaphore = await makeSemaphore();
      const chunk = "x".repeat(1_024);
      const results = await liveBatch({
        tasks: [
          {
            description: "large newline-free output",
            prompt: JSON.stringify({
              stdout: [chunk],
              stdoutRepeat: 2_048,
            }),
          },
        ],
        parentCwd: directory,
        command: fixtureCommand(),
        semaphore,
      });
      const result = resultAt(results, 0);

      expect(result.status).toBe("completed");
      expectBoundedCapture(result.output);
      expect(result.output.startsWith("x")).toBe(true);
      expect(result.output).toContain("omitted");
    });
  }, 10_000);

  it("enforces one global cap across calls", async () => {
    await withTempDirectory(async (directory) => {
      const startedDirectory = join(directory, "started");
      const releaseDirectory = join(directory, "release");
      await Promise.all([
        mkdir(startedDirectory, { recursive: true }),
        mkdir(releaseDirectory, { recursive: true }),
      ]);
      const taskIds = [
        ...Array.from({ length: 6 }, (_, index) => `left-${String(index + 1)}`),
        ...Array.from(
          { length: 6 },
          (_, index) => `right-${String(index + 1)}`,
        ),
      ];
      const tasksFor = (side: "left" | "right"): ReadonlyArray<SubagentTask> =>
        Array.from({ length: 6 }, (_, index) => {
          const taskId = `${side}-${String(index + 1)}`;
          return {
            description: taskId,
            prompt: JSON.stringify({
              taskId,
              startedDirectory,
              releaseDirectory,
              stdout: [taskId],
            }),
          };
        });
      const semaphore = await makeSemaphore();
      const leftController = new AbortController();
      const rightController = new AbortController();
      const left = Effect.runPromise(
        executeBatch({
          tasks: tasksFor("left"),
          parentCwd: directory,
          command: fixtureCommand(),
          semaphore,
        }).pipe(Effect.provide(ProcessService.Live)),
        { signal: leftController.signal },
      );
      const right = Effect.runPromise(
        executeBatch({
          tasks: tasksFor("right"),
          parentCwd: directory,
          command: fixtureCommand(),
          semaphore,
        }).pipe(Effect.provide(ProcessService.Live)),
        { signal: rightController.signal },
      );

      try {
        await waitForMarkerCount(startedDirectory, 3);
        await expectStableMarkerCount(startedDirectory, 3, 200);

        const released = new Set<string>();
        for (let startedCount = 3; startedCount < 12; startedCount += 1) {
          const started = await markerNames(startedDirectory);
          const taskId = started.find((name) => !released.has(name));
          if (taskId === undefined) {
            throw new Error("expected an unreleased live task");
          }
          released.add(taskId);
          await writeFile(join(releaseDirectory, taskId), "release\n", "utf8");
          await waitForMarkerCount(startedDirectory, startedCount + 1);
          await expectStableMarkerCount(startedDirectory, startedCount + 1, 50);
        }

        expect(await markerNames(startedDirectory)).toHaveLength(12);
        await Promise.all(
          taskIds.map((taskId) =>
            writeFile(join(releaseDirectory, taskId), "release\n", "utf8"),
          ),
        );
        const [leftResults, rightResults] = await Promise.all([left, right]);
        expect(
          [...leftResults, ...rightResults].map((result) => result.status),
        ).toEqual(Array.from({ length: 12 }, () => "completed"));
        expect(await markerNames(startedDirectory)).toHaveLength(12);
      } finally {
        await Promise.all(
          taskIds.map((taskId) =>
            writeFile(join(releaseDirectory, taskId), "release\n", "utf8"),
          ),
        );
        leftController.abort();
        rightController.abort();
        await Promise.allSettled([left, right]);
      }
    });
  });

  it("publishes monotonic settlement counts", async () => {
    await withTempDirectory(async (directory) => {
      const semaphore = await makeSemaphore();
      const settlements: Array<number> = [];
      await liveBatch({
        tasks: [
          {
            description: "first",
            prompt: JSON.stringify({ delayMs: 80 }),
          },
          {
            description: "second",
            prompt: JSON.stringify({ delayMs: 10 }),
          },
          {
            description: "third",
            prompt: JSON.stringify({ delayMs: 40 }),
          },
        ],
        parentCwd: directory,
        command: fixtureCommand(),
        semaphore,
        onTaskSettled: (completed) => settlements.push(completed),
      });

      expect(settlements).toEqual([1, 2, 3]);
    });
  });
});

const cleanExit: ProcessExit = { code: 0, signal: null };

const exitedReport = (
  exit: ProcessExit,
  signalsAttempted: ReadonlyArray<"SIGTERM" | "SIGKILL"> = [],
): ProcessShutdownReport => ({
  stdin: { _tag: "Completed" },
  signalsAttempted,
  signalErrors: [],
  processErrors: [],
  terminal: { _tag: "Exited", exit },
  terminalUnconfirmed: false,
  deadlineExceeded: false,
});

interface ScriptedProcessInput {
  readonly writeStdin?: (value: string) => Effect.Effect<void, ProcessError>;
  readonly requestStdinEnd?: Effect.Effect<void, ProcessError>;
  readonly awaitStdinEnd?: Effect.Effect<void, ProcessError>;
  readonly stdoutChunks?: Stream.Stream<string, ProcessError>;
  readonly stderrChunks?: Stream.Stream<string, ProcessError>;
  readonly waitForExit?: Effect.Effect<ProcessExit, ProcessError>;
  readonly kill?: (
    signal: "SIGTERM" | "SIGKILL",
  ) => Effect.Effect<void, ProcessError>;
  readonly unref?: Effect.Effect<void, ProcessError>;
  readonly shutdown?: Effect.Effect<ProcessShutdownReport>;
}

const makeScriptedProcess = (
  input: ScriptedProcessInput = {},
): ManagedProcess => {
  const requestStdinEnd = input.requestStdinEnd ?? Effect.void;
  const awaitStdinEnd = input.awaitStdinEnd ?? Effect.void;
  return {
    writeStdin: input.writeStdin ?? (() => Effect.void),
    requestStdinEnd,
    awaitStdinEnd,
    endStdin: requestStdinEnd.pipe(Effect.zipRight(awaitStdinEnd)),
    stdoutChunks: input.stdoutChunks ?? Stream.fromIterable(["ok"]),
    stderrChunks: input.stderrChunks ?? Stream.empty,
    waitForExit: input.waitForExit ?? Effect.succeed(cleanExit),
    kill: input.kill ?? (() => Effect.void),
    unref: input.unref ?? Effect.void,
    shutdown: input.shutdown ?? Effect.succeed(exitedReport(cleanExit)),
  };
};

interface ScriptedLayerInput {
  readonly childFor: (cwd: string | undefined) => ManagedProcess;
  readonly spawnFailureCwd?: string;
}

const makeScriptedLayer = (input: ScriptedLayerInput) =>
  Layer.succeed(ProcessService, {
    spawnScoped: (_command, _args, options) => {
      if (options.cwd === input.spawnFailureCwd) {
        return Effect.fail(
          new ProcessError({ operation: "spawn", message: "spawn broke" }),
        );
      }
      const child = input.childFor(options.cwd);
      return Effect.acquireRelease(Effect.succeed(child), (managed) =>
        managed.shutdown.pipe(Effect.asVoid),
      );
    },
    spawnDetached: () =>
      Effect.die(new Error("unexpected scripted detached process")),
  } satisfies ProcessServiceShape);

const runScriptedBatch = (
  input: ExecuteBatchInput,
  layer: ReturnType<typeof makeScriptedLayer>,
) => Effect.runPromise(executeBatch(input).pipe(Effect.provide(layer)));

describe("subagent batch execution with scripted Process Service failures", () => {
  it("isolates a spawn failure", async () => {
    await withTempDirectory(async (directory) => {
      const failedCwd = resolve(directory, "spawn-failure");
      const successfulCwd = resolve(directory, "success");
      const success = makeScriptedProcess();
      const layer = makeScriptedLayer({
        spawnFailureCwd: failedCwd,
        childFor: () => success,
      });
      const semaphore = await makeSemaphore();
      const results = await runScriptedBatch(
        {
          tasks: [
            { description: "spawn failure", prompt: "prompt", cwd: failedCwd },
            {
              description: "successful sibling",
              prompt: "prompt",
              cwd: successfulCwd,
            },
          ],
          parentCwd: directory,
          command: fixtureCommand(),
          semaphore,
        },
        layer,
      );

      const failed = resultAt(results, 0);
      expect(failed).toMatchObject({
        status: "failed",
        exitCode: null,
        signal: null,
      });
      expect(failed.stderr).toContain("[spawn] spawn broke");
      expectBoundedCapture(failed.stderr ?? "");
      expect(resultAt(results, 1).status).toBe("completed");
    });
  });

  it("drains the sibling stream after a stdout failure", async () => {
    await withTempDirectory(async (directory) => {
      const failedCwd = resolve(directory, "stdout-failure");
      const successfulCwd = resolve(directory, "success");
      const stdoutFailure = makeScriptedProcess({
        stdoutChunks: Stream.fail(
          new ProcessError({
            operation: "stream",
            message: "stdout broke",
          }),
        ),
        stderrChunks: Stream.fromEffect(
          Effect.sleep("30 millis").pipe(Effect.as("late stderr")),
        ),
      });
      const success = makeScriptedProcess();
      const layer = makeScriptedLayer({
        childFor: (cwd) => (cwd === failedCwd ? stdoutFailure : success),
      });
      const semaphore = await makeSemaphore();
      const results = await runScriptedBatch(
        {
          tasks: [
            { description: "stdout failure", prompt: "prompt", cwd: failedCwd },
            {
              description: "successful sibling",
              prompt: "prompt",
              cwd: successfulCwd,
            },
          ],
          parentCwd: directory,
          command: fixtureCommand(),
          semaphore,
        },
        layer,
      );

      const failed = resultAt(results, 0);
      expect(failed).toMatchObject({
        status: "failed",
        exitCode: 0,
        signal: null,
      });
      expect(failed.stderr).toContain("late stderr");
      expect(failed.stderr).toContain("[stream] stdout broke");
      expectBoundedCapture(failed.stderr ?? "");
      expect(resultAt(results, 1).status).toBe("completed");
    });
  });

  it("shuts down while drains remain active after stdin failure", async () => {
    await withTempDirectory(async (directory) => {
      const failedCwd = resolve(directory, "stdin-failure");
      const successfulCwd = resolve(directory, "success");
      const terminal = await Effect.runPromise(
        Deferred.make<ProcessExit, ProcessError>(),
      );
      const drainsStarted = await Effect.runPromise(Deferred.make<void>());
      const events: Array<string> = [];
      let startedCount = 0;
      const drain = (name: "stdout" | "stderr") =>
        Stream.fromEffect(
          Effect.sync(() => {
            events.push(`${name}-started`);
            startedCount += 1;
            return startedCount;
          }).pipe(
            Effect.flatMap((count) =>
              count === 2
                ? Deferred.succeed(drainsStarted, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.zipRight(Deferred.await(terminal)),
            Effect.as(`${name} drained`),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                events.push(`${name}-interrupted`);
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                events.push(`${name}-stopped`);
              }),
            ),
          ),
        );
      const signalExit: ProcessExit = { code: null, signal: "SIGTERM" };
      const shutdown = await Effect.runPromise(
        Effect.cached(
          Effect.sync(() => {
            events.push("shutdown-started");
          }).pipe(
            Effect.zipRight(Deferred.await(drainsStarted)),
            Effect.tap(() =>
              Effect.sync(() => {
                events.push("shutdown-observed-drains");
              }),
            ),
            Effect.zipRight(
              Deferred.succeed(terminal, signalExit).pipe(Effect.asVoid),
            ),
            Effect.as(exitedReport(signalExit, ["SIGTERM"])),
          ),
        ),
      );
      const stdinFailure = makeScriptedProcess({
        writeStdin: () =>
          Effect.fail(
            new ProcessError({
              operation: "stdin",
              message: "stdin broke",
            }),
          ),
        stdoutChunks: drain("stdout"),
        stderrChunks: drain("stderr"),
        waitForExit: Deferred.await(terminal),
        shutdown,
      });
      const success = makeScriptedProcess();
      const layer = makeScriptedLayer({
        childFor: (cwd) => (cwd === failedCwd ? stdinFailure : success),
      });
      const semaphore = await makeSemaphore();
      const results = await runScriptedBatch(
        {
          tasks: [
            { description: "stdin failure", prompt: "prompt", cwd: failedCwd },
            {
              description: "successful sibling",
              prompt: "prompt",
              cwd: successfulCwd,
            },
          ],
          parentCwd: directory,
          command: fixtureCommand(),
          semaphore,
        },
        layer,
      );

      const failed = resultAt(results, 0);
      expect(failed).toMatchObject({
        status: "failed",
        exitCode: null,
        signal: "SIGTERM",
      });
      expect(failed.stderr).toContain("stderr drained");
      expect(failed.stderr).toContain("[stdin] stdin broke");
      expectBoundedCapture(failed.stderr ?? "");
      expect(events).not.toContain("stdout-interrupted");
      expect(events).not.toContain("stderr-interrupted");
      expect(events.indexOf("stdout-started")).toBeLessThan(
        events.indexOf("shutdown-observed-drains"),
      );
      expect(events.indexOf("stderr-started")).toBeLessThan(
        events.indexOf("shutdown-observed-drains"),
      );
      expect(events.indexOf("shutdown-started")).toBeLessThan(
        events.indexOf("stdout-stopped"),
      );
      expect(events.indexOf("shutdown-started")).toBeLessThan(
        events.indexOf("stderr-stopped"),
      );
      expect(resultAt(results, 1).status).toBe("completed");
    });
  });
});

describe("subagent batch cancellation", () => {
  it("interrupts queued tasks without spawning or leaking permits", async () => {
    await withTempDirectory(async (directory) => {
      let spawnCalls = 0;
      const success = makeScriptedProcess();
      const layer = makeScriptedLayer({
        childFor: () => {
          spawnCalls += 1;
          return success;
        },
      });
      const runner = makeEffectRunner(layer);
      const semaphore = await runner.runPromise(Effect.makeSemaphore(0));
      const invocationStarted = Promise.withResolvers<void>();
      const controller = new AbortController();

      try {
        const running = runner.runPromise(
          Effect.sync(() => invocationStarted.resolve()).pipe(
            Effect.zipRight(
              executeBatch({
                tasks: [{ description: "queued", prompt: "prompt" }],
                parentCwd: directory,
                command: fixtureCommand(),
                semaphore,
              }),
            ),
          ),
          { signal: controller.signal },
        );
        await invocationStarted.promise;
        controller.abort();

        await expect(running).rejects.toThrow();
        expect(spawnCalls).toBe(0);

        await runner.runPromise(semaphore.release(1));
        const later = await runner.runPromise(
          executeBatch({
            tasks: [{ description: "later", prompt: "prompt" }],
            parentCwd: directory,
            command: fixtureCommand(),
            semaphore,
          }),
        );
        expect(resultAt(later, 0).status).toBe("completed");
        expect(spawnCalls).toBe(1);
      } finally {
        controller.abort();
        await runner.dispose();
      }
    });
  });

  it("shuts down running tasks and releases permits on interruption", async () => {
    await withTempDirectory(async (directory) => {
      const runningCwd = resolve(directory, "running");
      const successfulCwd = resolve(directory, "success");
      const terminal = await Effect.runPromise(
        Deferred.make<ProcessExit, ProcessError>(),
      );
      const spawned = Promise.withResolvers<void>();
      const killObserved = Promise.withResolvers<"SIGTERM" | "SIGKILL">();
      const signals: Array<"SIGTERM" | "SIGKILL"> = [];
      const kill = (signal: "SIGTERM" | "SIGKILL") =>
        Effect.sync(() => {
          signals.push(signal);
          killObserved.resolve(signal);
        });
      const shutdown = await Effect.runPromise(
        Effect.cached(
          kill("SIGTERM").pipe(
            Effect.zipRight(Deferred.await(terminal)),
            Effect.match({
              onFailure: (error): ProcessShutdownReport => ({
                stdin: { _tag: "Completed" },
                signalsAttempted: ["SIGTERM"],
                signalErrors: [],
                processErrors: [],
                terminal: { _tag: "Failed", error },
                terminalUnconfirmed: false,
                deadlineExceeded: false,
              }),
              onSuccess: (exit) => exitedReport(exit, ["SIGTERM"]),
            }),
          ),
        ),
      );
      const neverExiting = makeScriptedProcess({
        stdoutChunks: Stream.empty,
        stderrChunks: Stream.empty,
        waitForExit: Deferred.await(terminal),
        kill,
        shutdown,
      });
      const success = makeScriptedProcess();
      const layer = makeScriptedLayer({
        childFor: (cwd) => {
          if (cwd === runningCwd) {
            spawned.resolve();
            return neverExiting;
          }
          return success;
        },
      });
      const runner = makeEffectRunner(layer);
      const semaphore = await runner.runPromise(Effect.makeSemaphore(1));
      const controller = new AbortController();

      try {
        const running = runner.runPromise(
          executeBatch({
            tasks: [
              {
                description: "running",
                prompt: "prompt",
                cwd: runningCwd,
              },
            ],
            parentCwd: directory,
            command: fixtureCommand(),
            semaphore,
          }),
          { signal: controller.signal },
        );
        await spawned.promise;
        controller.abort();
        expect(await killObserved.promise).toBe("SIGTERM");
        await runner.runPromise(
          Deferred.succeed(terminal, { code: null, signal: "SIGTERM" }).pipe(
            Effect.asVoid,
          ),
        );

        await expect(running).rejects.toThrow();
        expect(signals).toEqual(["SIGTERM"]);

        const later = await runner.runPromise(
          executeBatch({
            tasks: [
              {
                description: "later",
                prompt: "prompt",
                cwd: successfulCwd,
              },
            ],
            parentCwd: directory,
            command: fixtureCommand(),
            semaphore,
          }),
        );
        expect(resultAt(later, 0).status).toBe("completed");
      } finally {
        controller.abort();
        await runner.dispose();
      }
    });
  });
});
