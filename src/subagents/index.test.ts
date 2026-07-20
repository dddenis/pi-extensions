import type { ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
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
import type { ChildCommand, ParentSnapshot } from "./child-command";
import type { ExecuteBatchInput } from "./execution";
import {
  makeSubagentRuntime,
  type RegisteredSubagentTool,
  registerSubagent,
  type SubagentParentContext,
  type SubagentRegistrationPort,
  type SubagentRequest,
  type SubagentRuntime,
  SubagentRuntimeStateLive,
  type SubagentToolDetails,
} from "./index";
import {
  formatProgress,
  formatSubagentResults,
  type SubagentTaskResult,
} from "./output";

const toolCall = (arguments_: Record<string, unknown>): ToolCall => ({
  type: "toolCall",
  id: "test-call",
  name: "subagent",
  arguments: arguments_,
});

const orderedResults: ReadonlyArray<SubagentTaskResult> = [
  {
    description: "first",
    cwd: "/workspace/first",
    status: "completed",
    exitCode: 0,
    signal: null,
    output: "first child output\n",
  },
  {
    description: "second",
    cwd: "/workspace/second",
    status: "failed",
    exitCode: 7,
    signal: null,
    output: "second child output\n",
    stderr: "second child error\n",
  },
];

const makeRuntime = (
  results: ReadonlyArray<SubagentTaskResult> = orderedResults,
): SubagentRuntime => ({
  run: () => Promise.resolve(results),
  dispose: () => Promise.resolve(),
});

interface RegistrationHarness {
  readonly onlyTool: () => RegisteredSubagentTool;
  readonly shutdownHandler: () => () => Promise<void>;
  readonly thinkingReads: () => number;
  readonly setThinkingLevel: (level: string) => void;
}

const makeRegistrationHarness = (
  runtime: SubagentRuntime = makeRuntime(),
  commandBuilder?: (snapshot: ParentSnapshot) => ChildCommand,
): RegistrationHarness => {
  const tools: RegisteredSubagentTool[] = [];
  let shutdown: (() => Promise<void>) | undefined;
  let thinkingReads = 0;
  let thinkingLevel = "high";

  const port: SubagentRegistrationPort = {
    registerTool: (tool) => tools.push(tool),
    onSessionShutdown: (handler) => {
      shutdown = handler;
    },
    getThinkingLevel: () => {
      thinkingReads += 1;
      return thinkingLevel;
    },
  };

  registerSubagent(port, runtime, commandBuilder);

  const onlyTool = (): RegisteredSubagentTool => {
    const tool = tools[0];
    if (tool === undefined || tools.length !== 1) {
      throw new Error("expected exactly one registered subagent tool");
    }
    return tool;
  };

  const shutdownHandler = (): (() => Promise<void>) => {
    if (shutdown === undefined) throw new Error("shutdown was not registered");
    return shutdown;
  };

  return {
    onlyTool,
    shutdownHandler,
    thinkingReads: () => thinkingReads,
    setThinkingLevel: (level) => {
      thinkingLevel = level;
    },
  };
};

const validRequest = (): SubagentRequest => ({
  tasks: [{ description: "inspect", prompt: "perform the inspection" }],
});

const parentContext = (): SubagentParentContext => ({
  cwd: "/workspace",
  model: { provider: "provider-a", id: "model-a" },
});

describe("subagent tool registration and schema", () => {
  it("registers exactly one parallel subagent tool", () => {
    const harness = makeRegistrationHarness();
    const tool = harness.onlyTool();

    expect(tool.name).toBe("subagent");
    expect(tool.executionMode).toBe("parallel");
  });

  it("rejects empty tasks and whitespace-only required strings", () => {
    const tool = makeRegistrationHarness().onlyTool();
    const invalidRequests: ReadonlyArray<Record<string, unknown>> = [
      { tasks: [] },
      { tasks: [{ description: "", prompt: "prompt" }] },
      { tasks: [{ description: " \n\t", prompt: "prompt" }] },
      { tasks: [{ description: "description", prompt: "" }] },
      { tasks: [{ description: "description", prompt: " \n\t" }] },
    ];

    for (const invalid of invalidRequests) {
      expect(() => validateToolArguments(tool, toolCall(invalid))).toThrow();
    }
  });

  it("rejects root and task unknown properties", () => {
    const tool = makeRegistrationHarness().onlyTool();

    expect(() =>
      validateToolArguments(
        tool,
        toolCall({
          tasks: [{ description: "description", prompt: "prompt" }],
          unknown: true,
        }),
      ),
    ).toThrow();
    expect(() =>
      validateToolArguments(
        tool,
        toolCall({
          tasks: [
            {
              description: "description",
              prompt: "prompt",
              unknown: true,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects every caller override and retry knob", () => {
    const tool = makeRegistrationHarness().onlyTool();
    const forbiddenFields = [
      "agent",
      "model",
      "thinking",
      "tools",
      "concurrency",
      "output",
      "timeout",
      "retry",
      "retries",
      "maxRetries",
    ] as const;

    for (const field of forbiddenFields) {
      expect(() =>
        validateToolArguments(
          tool,
          toolCall({
            tasks: [{ description: "description", prompt: "prompt" }],
            [field]: true,
          }),
        ),
      ).toThrow();
    }
  });

  it("accepts a large non-empty task array without imposing a maximum", () => {
    const tool = makeRegistrationHarness().onlyTool();
    const tasks = Array.from({ length: 1_000 }, (_, index) => ({
      description: `task ${String(index)}`,
      prompt: `prompt ${String(index)}`,
    }));

    const accepted = validateToolArguments(tool, toolCall({ tasks }));

    expect(accepted.tasks).toHaveLength(1_000);
  });

  it("preserves accepted prompt edges", () => {
    const tool = makeRegistrationHarness().onlyTool();
    const accepted = validateToolArguments(
      tool,
      toolCall({
        tasks: [
          {
            description: " inspect ",
            prompt: " \nkeep these edges\n ",
          },
        ],
      }),
    );

    expect(accepted.tasks[0].prompt).toBe(" \nkeep these edges\n ");
  });
});

describe("subagent tool execution boundary", () => {
  it("rejects before runtime when the parent model is missing", async () => {
    let runtimeCalls = 0;
    const runtime: SubagentRuntime = {
      run: () => {
        runtimeCalls += 1;
        return Promise.resolve(orderedResults);
      },
      dispose: () => Promise.resolve(),
    };
    const harness = makeRegistrationHarness(runtime);

    await expect(
      harness
        .onlyTool()
        .execute(validRequest(), undefined, undefined, { cwd: "/workspace" }),
    ).rejects.toThrow("subagent requires an active parent model");
    expect(runtimeCalls).toBe(0);
    expect(harness.thinkingReads()).toBe(0);
  });

  it("does not translate runtime initialization failure into task data", async () => {
    const failure = new Error("runtime failed");
    const updates: Array<AgentToolResult<SubagentToolDetails>> = [];
    const runtime: SubagentRuntime = {
      run: () => Promise.reject(failure),
      dispose: () => Promise.resolve(),
    };
    const harness = makeRegistrationHarness(runtime);

    await expect(
      harness
        .onlyTool()
        .execute(validRequest(), undefined, (update) => updates.push(update), {
          cwd: "/workspace",
          model: { provider: "provider-a", id: "model-a" },
        }),
    ).rejects.toBe(failure);
    expect(updates.some((update) => update.details._tag === "Complete")).toBe(
      false,
    );
  });

  it("snapshots model and thinking once per invocation", async () => {
    let provider = "provider-original";
    let modelId = "model-original";
    let cwd = "/workspace/original";
    let providerReads = 0;
    let modelIdReads = 0;
    const snapshots: Array<ParentSnapshot> = [];
    const inputs: Array<Omit<ExecuteBatchInput, "semaphore">> = [];
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ReadonlyArray<SubagentTaskResult>>();
    const runtime: SubagentRuntime = {
      run: (input) => {
        inputs.push(input);
        started.resolve();
        return release.promise;
      },
      dispose: () => Promise.resolve(),
    };
    const commandBuilder = (snapshot: ParentSnapshot): ChildCommand => {
      snapshots.push({ ...snapshot });
      return {
        command: `${snapshot.provider}/${snapshot.modelId}`,
        args: ["--thinking", snapshot.thinkingLevel],
      };
    };
    const harness = makeRegistrationHarness(runtime, commandBuilder);
    const context: SubagentParentContext = {
      get cwd() {
        return cwd;
      },
      model: {
        get provider() {
          providerReads += 1;
          return provider;
        },
        get id() {
          modelIdReads += 1;
          return modelId;
        },
      },
    };

    const execution = harness
      .onlyTool()
      .execute(validRequest(), undefined, undefined, context);
    await started.promise;
    provider = "provider-mutated";
    modelId = "model-mutated";
    cwd = "/workspace/mutated";
    harness.setThinkingLevel("low");
    release.resolve(orderedResults);
    await execution;

    expect(snapshots).toEqual([
      {
        provider: "provider-original",
        modelId: "model-original",
        thinkingLevel: "high",
      },
    ]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      parentCwd: "/workspace/original",
      command: {
        command: "provider-original/model-original",
        args: ["--thinking", "high"],
      },
    });
    expect(providerReads).toBe(1);
    expect(modelIdReads).toBe(1);
    expect(harness.thinkingReads()).toBe(1);
  });

  it("publishes only synchronized coarse progress", async () => {
    const updates: Array<AgentToolResult<SubagentToolDetails>> = [];
    const runtime: SubagentRuntime = {
      run: (input) => {
        input.onTaskSettled?.(1);
        input.onTaskSettled?.(2);
        return Promise.resolve(orderedResults);
      },
      dispose: () => Promise.resolve(),
    };
    const harness = makeRegistrationHarness(runtime);
    const request: SubagentRequest = {
      tasks: [
        { description: "first", prompt: "SECRET FIRST PROMPT" },
        { description: "second", prompt: "SECRET SECOND PROMPT" },
      ],
    };

    await harness
      .onlyTool()
      .execute(request, undefined, (update) => updates.push(update), {
        cwd: "/workspace",
        model: { provider: "provider-a", id: "model-a" },
      });

    expect(updates).toEqual([
      {
        content: [{ type: "text", text: formatProgress(0, 2) }],
        details: { _tag: "Progress", completed: 0, total: 2 },
      },
      {
        content: [{ type: "text", text: formatProgress(1, 2) }],
        details: { _tag: "Progress", completed: 1, total: 2 },
      },
      {
        content: [{ type: "text", text: formatProgress(2, 2) }],
        details: { _tag: "Progress", completed: 2, total: 2 },
      },
    ]);
    expect(updates.map((update) => update.content[0])).toEqual([
      { type: "text", text: "Subagents: 0/2 completed" },
      { type: "text", text: "Subagents: 1/2 completed" },
      { type: "text", text: "Subagents: 2/2 completed" },
    ]);
    const serialized = JSON.stringify(updates);
    expect(serialized).not.toContain("SECRET FIRST PROMPT");
    expect(serialized).not.toContain("SECRET SECOND PROMPT");
    expect(serialized).not.toContain("first child output");
    expect(serialized).not.toContain("second child output");
  });

  it("ignores a throwing progress callback", async () => {
    const runtime: SubagentRuntime = {
      run: (input) => {
        input.onTaskSettled?.(1);
        return Promise.resolve(orderedResults);
      },
      dispose: () => Promise.resolve(),
    };
    const harness = makeRegistrationHarness(runtime);

    const result = await harness.onlyTool().execute(
      validRequest(),
      undefined,
      () => {
        throw new Error("progress callback failed");
      },
      parentContext(),
    );

    expect(result.details).toEqual({
      _tag: "Complete",
      results: orderedResults,
    });
  });

  it("returns bounded text plus every structured result", async () => {
    const harness = makeRegistrationHarness(makeRuntime(orderedResults));

    const result = await harness
      .onlyTool()
      .execute(validRequest(), undefined, undefined, parentContext());

    expect(result.content).toEqual([
      { type: "text", text: formatSubagentResults(orderedResults) },
    ]);
    expect(result.details._tag).toBe("Complete");
    if (result.details._tag === "Complete") {
      expect(result.details.results).toBe(orderedResults);
      expect(result.details.results).toEqual(orderedResults);
    }
  });

  it("memoizes shutdown disposal", async () => {
    let disposeCalls = 0;
    const disposal = Promise.withResolvers<void>();
    const runtime: SubagentRuntime = {
      run: () => Promise.resolve(orderedResults),
      dispose: () => {
        disposeCalls += 1;
        return disposal.promise;
      },
    };
    const handler = makeRegistrationHarness(runtime).shutdownHandler();

    const first = handler();
    const second = handler();

    expect(first).toBe(second);
    expect(disposeCalls).toBe(1);
    disposal.resolve();
    await Promise.all([first, second]);
  });
});

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

describe("subagent scoped runtime shutdown", () => {
  it("interrupts shared work and waits for managed child shutdown", async () => {
    const terminal = await Effect.runPromise(
      Deferred.make<ProcessExit, ProcessError>(),
    );
    const spawned = Promise.withResolvers<void>();
    const exitAwaited = Promise.withResolvers<void>();
    const signalObserved = Promise.withResolvers<"SIGTERM" | "SIGKILL">();
    const signals: Array<"SIGTERM" | "SIGKILL"> = [];
    const shutdown = await Effect.runPromise(
      Effect.cached(
        Effect.sync(() => {
          signals.push("SIGTERM");
          signalObserved.resolve("SIGTERM");
        }).pipe(
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
    const child: ManagedProcess = {
      writeStdin: () => Effect.void,
      requestStdinEnd: Effect.void,
      awaitStdinEnd: Effect.void,
      endStdin: Effect.void,
      stdoutChunks: Stream.empty,
      stderrChunks: Stream.empty,
      waitForExit: Effect.sync(() => exitAwaited.resolve()).pipe(
        Effect.zipRight(Deferred.await(terminal)),
      ),
      kill: () => Effect.void,
      unref: Effect.void,
      shutdown,
    };
    const scriptedProcessLayer = Layer.succeed(ProcessService, {
      spawnScoped: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            spawned.resolve();
            return child;
          }),
          (managed) => managed.shutdown.pipe(Effect.asVoid),
        ),
      spawnDetached: () =>
        Effect.die(new Error("unexpected scripted detached process")),
    } satisfies ProcessServiceShape);
    const effectRunner = makeEffectRunner(
      Layer.merge(scriptedProcessLayer, SubagentRuntimeStateLive),
    );
    const backingRuntime = makeSubagentRuntime(effectRunner);
    let disposalCalls = 0;
    const runtime: SubagentRuntime = {
      run: backingRuntime.run,
      dispose: () => {
        disposalCalls += 1;
        return backingRuntime.dispose();
      },
    };
    const harness = makeRegistrationHarness(runtime, () => ({
      command: "pi",
      args: [],
    }));
    const handler = harness.shutdownHandler();
    const invocation = harness
      .onlyTool()
      .execute(validRequest(), undefined, undefined, parentContext());
    const outcome = invocation.then(
      (result) => ({ _tag: "Success" as const, result }),
      (error: unknown) => ({ _tag: "Failure" as const, error }),
    );

    await spawned.promise;
    await exitAwaited.promise;
    const firstShutdown = handler();
    expect(await signalObserved.promise).toBe("SIGTERM");
    await Effect.runPromise(
      Deferred.succeed(terminal, {
        code: null,
        signal: "SIGTERM",
      }).pipe(Effect.asVoid),
    );
    await firstShutdown;

    const invocationOutcome = await outcome;
    expect(invocationOutcome._tag).toBe("Failure");
    if (invocationOutcome._tag === "Failure") {
      expect(String(invocationOutcome.error)).toMatch(/interrupt/i);
    }
    const secondShutdown = handler();
    expect(secondShutdown).toBe(firstShutdown);
    await secondShutdown;
    expect(disposalCalls).toBe(1);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("starts every invocation shutdown in parallel before releasing cleanup", async () => {
    const cleanupRelease = await Effect.runPromise(Deferred.make<void>());
    const firstInvocationStarted = Promise.withResolvers<void>();
    const bothInvocationsStarted = Promise.withResolvers<void>();
    const firstCleanupStarted = Promise.withResolvers<void>();
    const bothInvocationsStopping = Promise.withResolvers<void>();
    const allActiveChildrenStopping = Promise.withResolvers<void>();
    const events: Array<string> = [];
    const spawned: Array<string> = [];
    const stoppingInvocations = new Set<string>();
    const stoppingChildren = new Set<string>();

    const invocationFor = (cwd: string): "left" | "right" =>
      cwd.includes("left-") ? "left" : "right";
    const taskName = (cwd: string): string => {
      const segments = cwd.split("/");
      return segments[segments.length - 1] ?? cwd;
    };
    const recordSpawn = (cwd: string): void => {
      const name = taskName(cwd);
      spawned.push(name);
      events.push(`spawn:${name}`);
      if (spawned.length === 2) firstInvocationStarted.resolve();
      if (spawned.length === 3) bothInvocationsStarted.resolve();
    };
    const recordShutdown = (cwd: string): void => {
      const name = taskName(cwd);
      events.push(`shutdown:${name}`);
      stoppingInvocations.add(invocationFor(cwd));
      stoppingChildren.add(name);
      firstCleanupStarted.resolve();
      if (stoppingInvocations.size === 2) bothInvocationsStopping.resolve();
      if (stoppingChildren.size === 3) allActiveChildrenStopping.resolve();
    };

    const scriptedProcessLayer = Layer.succeed(ProcessService, {
      spawnScoped: (_command, _args, options) => {
        const cwd = options.cwd ?? "/workspace/unavailable";
        return Effect.acquireRelease(
          Effect.gen(function* () {
            recordSpawn(cwd);
            const shutdown = yield* Effect.cached(
              Effect.sync(() => recordShutdown(cwd)).pipe(
                Effect.zipRight(Deferred.await(cleanupRelease)),
                Effect.as(
                  exitedReport({ code: null, signal: "SIGTERM" }, ["SIGTERM"]),
                ),
              ),
            );
            return {
              writeStdin: () => Effect.void,
              requestStdinEnd: Effect.void,
              awaitStdinEnd: Effect.void,
              endStdin: Effect.void,
              stdoutChunks: Stream.empty,
              stderrChunks: Stream.empty,
              waitForExit: Effect.never,
              kill: () => Effect.void,
              unref: Effect.void,
              shutdown,
            } satisfies ManagedProcess;
          }),
          (managed) => managed.shutdown.pipe(Effect.asVoid),
        );
      },
      spawnDetached: () =>
        Effect.die(new Error("unexpected scripted detached process")),
    } satisfies ProcessServiceShape);
    const effectRunner = makeEffectRunner(
      Layer.merge(scriptedProcessLayer, SubagentRuntimeStateLive),
    );
    const runtime = makeSubagentRuntime(effectRunner);
    const command = { command: "pi", args: [] } satisfies ChildCommand;
    const task = (description: string) => ({
      description,
      prompt: "prompt",
      cwd: description,
    });
    const left = runtime.run(
      {
        tasks: [task("left-1"), task("left-2")],
        parentCwd: "/workspace",
        command,
      },
      undefined,
    );
    const leftOutcome = left.then(
      () => "completed" as const,
      () => "interrupted" as const,
    );

    await firstInvocationStarted.promise;
    const right = runtime.run(
      {
        tasks: [task("right-1"), task("right-2")],
        parentCwd: "/workspace",
        command,
      },
      undefined,
    );
    const rightOutcome = right.then(
      () => "completed" as const,
      () => "interrupted" as const,
    );

    await bothInvocationsStarted.promise;
    expect(spawned).toEqual(["left-1", "left-2", "right-1"]);
    const disposal = runtime.dispose();
    await firstCleanupStarted.promise;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const allStoppedBeforeRelease = await Promise.race([
      allActiveChildrenStopping.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), 100);
      }),
    ]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    await Effect.runPromise(
      Deferred.succeed(cleanupRelease, undefined).pipe(Effect.asVoid),
    );
    await disposal;
    const outcomes = await Promise.all([leftOutcome, rightOutcome]);

    const firstShutdown = events.findIndex((event) =>
      event.startsWith("shutdown:"),
    );
    const spawnsAfterShutdown = events
      .slice(firstShutdown + 1)
      .filter((event) => event.startsWith("spawn:"));
    expect(allStoppedBeforeRelease).toBe(true);
    await expect(bothInvocationsStopping.promise).resolves.toBeUndefined();
    expect(stoppingInvocations).toEqual(new Set(["left", "right"]));
    expect(stoppingChildren).toEqual(new Set(["left-1", "left-2", "right-1"]));
    expect(spawnsAfterShutdown).toEqual([]);
    expect(spawned).not.toContain("right-2");
    expect(outcomes).toEqual(["interrupted", "interrupted"]);
  });
});
