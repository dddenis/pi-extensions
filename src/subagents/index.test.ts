import type { Model } from "@earendil-works/pi-ai";
import { Effect, Either, Layer } from "effect";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { makeEffectRunner } from "../lib/effect-runtime";
import { SubagentBatch, type BatchProgress } from "./batch";
import { InvalidSubagentInput } from "./errors";
import {
  makeParentRuntime,
  registerCompletionTool,
  registerParentTool,
  registerSubagentsForEnvironment,
  type CliModelResolver,
  type CompletionRuntime,
  type CompletionToolDefinition,
  type ParentRuntime,
  type ParentRuntimeInput,
  type ParentToolDefinition,
  type ParentToolRegistrationPort,
  type SubagentRuntimeFactories,
} from "./index";
import type { RunResult } from "./schemas";

const testModel = (
  provider: string,
  id: string,
  reasoning: boolean,
): Model<"openai-completions"> => ({
  provider,
  id,
  name: id,
  api: "openai-completions",
  baseUrl: "https://example.test/v1",
  reasoning,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
});

const progress: BatchProgress = {
  diagnostics: [],
  children: [
    {
      runId: "run-1",
      agent: "alpha",
      lifecycle: "RUNNING",
      items: [{ type: "assistant", text: "Checking interfaces" }],
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: 0.5,
        turns: 1,
      },
    },
  ],
};

const finalResult: RunResult = {
  runId: "run-1",
  agent: "alpha",
  status: "DONE",
  summary: "Interfaces verified",
  reportPath: "/abs/report.md",
  exitCode: 0,
  signal: null,
  usage: {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    cost: 0.5,
    turns: 1,
  },
  artifacts: {
    runId: "run-1",
    runDirectory: "/runs/run-1",
    manifestPath: "/runs/run-1/run.json",
    taskPath: "/runs/run-1/task.md",
    systemPromptPath: "/runs/run-1/system-prompt.md",
    eventsPath: "/runs/run-1/events.jsonl",
    stderrPath: "/runs/run-1/stderr.log",
    statusPath: "/runs/run-1/status.json",
  },
  diagnostics: [],
};

interface ParentHarnessOptions {
  readonly resolvePattern?: string;
  readonly rejectWith?: InvalidSubagentInput;
  readonly invocationDiagnostics?: ReadonlyArray<string>;
}

const makeParentHarness = (options: ParentHarnessOptions = {}) => {
  let tool: ParentToolDefinition | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let runtimeInput: ParentRuntimeInput | undefined;
  let disposeCalls = 0;

  const runtime: ParentRuntime = {
    execute: async (input) => {
      runtimeInput = input;
      if (options.rejectWith !== undefined) throw options.rejectWith;
      if (options.resolvePattern !== undefined) {
        const resolution = await Effect.runPromise(
          Effect.either(input.models.resolve(options.resolvePattern, "high")),
        );
        if (Either.isLeft(resolution)) throw resolution.left;
      }
      const invocationDiagnostics = Object.freeze([
        ...(options.invocationDiagnostics ?? []),
      ]);
      await input.onProgress({
        ...progress,
        diagnostics: invocationDiagnostics,
      });
      return { results: [finalResult], diagnostics: invocationDiagnostics };
    },
    dispose: async () => {
      disposeCalls += 1;
    },
  };

  const activeToolNames = ["web_search", "read"];
  const tools = [
    {
      name: "read",
      sourceInfo: {
        path: "<builtin:read>",
        source: "builtin",
        scope: "temporary" as const,
        origin: "top-level" as const,
      },
    },
    {
      name: "web_search",
      sourceInfo: {
        path: "./provider.ts",
        source: "search-extension",
        scope: "user" as const,
        origin: "package" as const,
        baseDir: "/extensions/search",
      },
    },
    {
      name: "configured_inactive",
      sourceInfo: {
        path: "<builtin:configured_inactive>",
        source: "builtin",
        scope: "temporary" as const,
        origin: "top-level" as const,
      },
    },
  ];

  const port: ParentToolRegistrationPort = {
    registerTool: (definition) => {
      tool = definition;
    },
    onSessionShutdown: (handler) => {
      shutdown = handler;
    },
    getThinkingLevel: () => "high",
    getActiveTools: () => activeToolNames,
    getAllTools: () => tools,
  };

  return {
    port,
    runtime,
    activeToolNames,
    tools,
    get tool() {
      if (tool === undefined) throw new Error("parent tool not registered");
      return tool;
    },
    get shutdown() {
      if (shutdown === undefined) throw new Error("shutdown not registered");
      return shutdown;
    },
    get runtimeInput() {
      if (runtimeInput === undefined) throw new Error("runtime not executed");
      return runtimeInput;
    },
    get disposeCalls() {
      return disposeCalls;
    },
  };
};

const resolver: CliModelResolver = ({ cliModel, cliThinking }) => {
  expect(cliModel).toBe("sonnet");
  expect(cliThinking).toBe("high");
  return {
    model: testModel("anthropic", "claude-sonnet-4-5", true),
    thinkingLevel: "medium",
    warning: "Pattern matched claude-sonnet-4-5",
    error: undefined,
  };
};

const executeContext = (
  model: { provider: string; id: string } | undefined,
) => ({
  cwd: "/parent/project",
  model,
  resolveModel: resolver,
});

const parentRuntimeInput = (
  signal: AbortSignal | undefined = undefined,
): ParentRuntimeInput => ({
  request: { tasks: [{ agent: "alpha", task: "Inspect" }] },
  parent: {
    cwd: "/parent/project",
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    activeToolNames: [],
    toolProviders: [],
  },
  models: {
    resolve: () => Effect.die("model resolution is unused in this test"),
  },
  signal,
  onProgress: async () => undefined,
});

describe("subagent extension adapter", () => {
  it("registers only the sequential parent subagent tool with strict task bounds", () => {
    const harness = makeParentHarness();
    registerParentTool(harness.port, harness.runtime);

    expect(harness.tool.name).toBe("subagent");
    expect(harness.tool.executionMode).toBe("sequential");
    expect(harness.tool.description).toBe(
      "Run one to three isolated child agents. The `general` agent name is always available through a bundled fallback and is used when an agent name is omitted.",
    );
    expect(harness.tool.parameters).toMatchObject({
      required: ["tasks"],
      additionalProperties: false,
      properties: {
        tasks: {
          minItems: 1,
          maxItems: 3,
          items: {
            additionalProperties: false,
          },
        },
      },
    });
    const itemSchema = harness.tool.parameters.properties.tasks.items;
    expect(itemSchema.required).toEqual(["task"]);
    expect(itemSchema.properties.agent).toMatchObject({
      description:
        "Optional agent definition name. Defaults to the always-available `general` agent. Specify another name only when intentionally using a specialized global definition.",
    });
    expect(
      Value.Check(harness.tool.parameters, {
        tasks: [{ task: "Inspect" }],
      }),
    ).toBe(true);
  });

  it("selects the parent or child default branch before constructing the other runtime", () => {
    const parent = makeParentHarness();
    let completionTool: CompletionToolDefinition | undefined;
    let parentRuntimeConstructions = 0;
    let completionRuntimeConstructions = 0;
    const factories: SubagentRuntimeFactories = {
      makeParentRuntime: () => {
        parentRuntimeConstructions += 1;
        return parent.runtime;
      },
      makeCompletionRuntime: () => {
        completionRuntimeConstructions += 1;
        return {
          execute: async () => ({
            content: [
              { type: "text", text: "Subagent completion recorded: DONE" },
            ],
            details: { status: "DONE", summary: "Complete" },
            terminate: true,
          }),
          dispose: async () => undefined,
        };
      },
    };
    const completionPort = {
      registerTool: (definition: CompletionToolDefinition) => {
        completionTool = definition;
      },
      onSessionShutdown: (_handler: () => Promise<void>) => undefined,
    };

    registerSubagentsForEnvironment(
      undefined,
      { parent: parent.port, completion: completionPort },
      factories,
    );
    expect(parent.tool.name).toBe("subagent");
    expect(completionTool).toBeUndefined();
    expect(parentRuntimeConstructions).toBe(1);
    expect(completionRuntimeConstructions).toBe(0);

    const childParent = makeParentHarness();
    registerSubagentsForEnvironment(
      "1",
      { parent: childParent.port, completion: completionPort },
      factories,
    );
    expect(completionTool?.name).toBe("complete_subagent");
    expect(() => childParent.tool).toThrow("parent tool not registered");
    expect(parentRuntimeConstructions).toBe(1);
    expect(completionRuntimeConstructions).toBe(1);
  });

  it("snapshots cwd, canonical model, thinking, and copied winning provenance", async () => {
    const harness = makeParentHarness();
    registerParentTool(harness.port, harness.runtime);
    const signal = new AbortController().signal;

    await harness.tool.execute(
      "call-1",
      { tasks: [{ agent: "alpha", task: "Inspect" }] },
      signal,
      undefined,
      executeContext({ provider: "openai-codex", id: "gpt-5.4" }),
    );

    expect(harness.runtimeInput.signal).toBe(signal);
    expect(harness.runtimeInput.parent).toEqual({
      cwd: "/parent/project",
      model: "openai-codex/gpt-5.4",
      thinking: "high",
      activeToolNames: ["web_search", "read"],
      toolProviders: [
        {
          name: "read",
          source: "builtin",
          path: "<builtin:read>",
        },
        {
          name: "web_search",
          source: "search-extension",
          path: "./provider.ts",
          baseDir: "/extensions/search",
        },
        {
          name: "configured_inactive",
          source: "builtin",
          path: "<builtin:configured_inactive>",
        },
      ],
    });
    expect(Object.isFrozen(harness.runtimeInput.parent)).toBe(true);
    expect(Object.isFrozen(harness.runtimeInput.parent.activeToolNames)).toBe(
      true,
    );
    expect(Object.isFrozen(harness.runtimeInput.parent.toolProviders)).toBe(
      true,
    );
    expect(harness.runtimeInput.parent.activeToolNames).not.toBe(
      harness.port.getActiveTools(),
    );
    expect(harness.runtimeInput.parent.toolProviders).not.toBe(
      harness.port.getAllTools(),
    );

    harness.activeToolNames.push("late_active");
    harness.tools.push({
      name: "late_configured",
      sourceInfo: {
        path: "<builtin:late_configured>",
        source: "builtin",
        scope: "temporary",
        origin: "top-level",
      },
    });
    expect(harness.runtimeInput.parent.activeToolNames).toEqual([
      "web_search",
      "read",
    ]);
    expect(
      harness.runtimeInput.parent.toolProviders.map(({ name }) => name),
    ).toEqual(["read", "web_search", "configured_inactive"]);
  });

  it("allows an undefined parent model into preflight", async () => {
    const harness = makeParentHarness();
    registerParentTool(harness.port, harness.runtime);

    await harness.tool.execute(
      "call-1",
      { tasks: [{ agent: "explicit-model", task: "Inspect" }] },
      undefined,
      undefined,
      executeContext(undefined),
    );

    expect(harness.runtimeInput.parent.model).toBeUndefined();
  });

  it("uses the execution-context model resolver without constructor identity checks", async () => {
    const harness = makeParentHarness({ resolvePattern: "sonnet" });
    registerParentTool(harness.port, harness.runtime);

    await harness.tool.execute(
      "call-1",
      { tasks: [{ agent: "alpha", task: "Inspect" }] },
      undefined,
      undefined,
      executeContext(undefined),
    );

    await expect(
      Effect.runPromise(harness.runtimeInput.models.resolve("sonnet", "high")),
    ).resolves.toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinking: "medium",
    });
  });

  it("clamps requested thinking to the resolved model capabilities", async () => {
    const harness = makeParentHarness({
      resolvePattern: "test-provider/exact-non-reasoning",
    });
    registerParentTool(harness.port, harness.runtime);

    await harness.tool.execute(
      "call-1",
      { tasks: [{ agent: "alpha", task: "Inspect" }] },
      undefined,
      undefined,
      {
        ...executeContext(undefined),
        resolveModel: () => ({
          model: testModel("test-provider", "exact-non-reasoning", false),
          thinkingLevel: undefined,
          warning: undefined,
          error: undefined,
        }),
      },
    );

    await expect(
      Effect.runPromise(
        harness.runtimeInput.models.resolve(
          "test-provider/exact-non-reasoning",
          "high",
        ),
      ),
    ).resolves.toEqual({
      model: "test-provider/exact-non-reasoning",
      thinking: "off",
    });
  });

  it("uses resolveCliModel semantics and retains warnings in progress and final diagnostics", async () => {
    const harness = makeParentHarness({
      resolvePattern: "sonnet",
      invocationDiagnostics: [
        "agent definition (/agents/broken.md): invalid YAML",
      ],
    });
    registerParentTool(harness.port, harness.runtime);
    const updates: Array<{
      content: ReadonlyArray<{ type: "text"; text: string }>;
      details: unknown;
    }> = [];

    const result = await harness.tool.execute(
      "call-1",
      { tasks: [{ agent: "alpha", task: "Inspect" }] },
      undefined,
      (update) => updates.push(update),
      executeContext(undefined),
    );

    const model = await Effect.runPromise(
      harness.runtimeInput.models.resolve("sonnet", "high"),
    );
    expect(model).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinking: "medium",
    });
    expect(Object.isFrozen(model)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.content[0]?.text).toBe("Subagents: 1 running");
    expect(updates[0]?.details).toEqual({
      phase: "progress",
      progress: {
        ...progress,
        diagnostics: ["agent definition (/agents/broken.md): invalid YAML"],
      },
      diagnostics: [
        "agent definition (/agents/broken.md): invalid YAML",
        "Pattern matched claude-sonnet-4-5",
      ],
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "run-1 alpha DONE: Interfaces verified (/abs/report.md)",
        },
      ],
      details: {
        phase: "complete",
        results: [finalResult],
        diagnostics: [
          "agent definition (/agents/broken.md): invalid YAML",
          "Pattern matched claude-sonnet-4-5",
        ],
      },
    });
    expect(result.content[0]?.text).toBe(
      "run-1 alpha DONE: Interfaces verified (/abs/report.md)",
    );
    expect(result.details.phase).toBe("complete");
    if (result.details.phase !== "complete") return;
    expect(result.details.results[0]?.diagnostics).toEqual([]);
  });

  it("promotes resolver errors to a single formatted preflight error", async () => {
    const failingResolver: CliModelResolver = () => ({
      model: undefined,
      thinkingLevel: undefined,
      warning: "deprecated alias",
      error: "No model matched pattern",
    });
    const harness = makeParentHarness({ resolvePattern: "sonnet" });
    registerParentTool(harness.port, harness.runtime);

    await expect(
      harness.tool.execute(
        "call-1",
        { tasks: [{ agent: "alpha", task: "Inspect" }] },
        undefined,
        undefined,
        {
          ...executeContext(undefined),
          resolveModel: failingResolver,
        },
      ),
    ).rejects.toThrow(
      "InvalidSubagentInput (sonnet): No model matched pattern",
    );
  });

  it("passes concise progress content with complete details and the AbortSignal", async () => {
    const harness = makeParentHarness();
    registerParentTool(harness.port, harness.runtime);
    const controller = new AbortController();
    const updates: Array<unknown> = [];

    await harness.tool.execute(
      "call-1",
      { tasks: [{ agent: "alpha", task: "SECRET TASK" }] },
      controller.signal,
      (update) => updates.push(update),
      executeContext({ provider: "openai-codex", id: "gpt-5.4" }),
    );

    expect(harness.runtimeInput.signal).toBe(controller.signal);
    expect(updates).toEqual([
      {
        content: [{ type: "text", text: "Subagents: 1 running" }],
        details: { phase: "progress", progress, diagnostics: [] },
      },
    ]);
    expect(JSON.stringify(updates)).not.toContain("SECRET TASK");
  });

  it("formats final runtime errors exactly once", async () => {
    const harness = makeParentHarness({
      rejectWith: new InvalidSubagentInput({
        subject: "request",
        message: "invalid tasks",
      }),
    });
    registerParentTool(harness.port, harness.runtime);

    await expect(
      harness.tool.execute(
        "call-1",
        { tasks: [{ agent: "alpha", task: "Inspect" }] },
        undefined,
        undefined,
        executeContext(undefined),
      ),
    ).rejects.toThrow("InvalidSubagentInput (request): invalid tasks");
  });

  it("strips terminal controls from adapter error display", async () => {
    const harness = makeParentHarness({
      rejectWith: new InvalidSubagentInput({
        subject: "request\u001b[31m",
        message:
          "invalid\u0007 \u001b_APC-PAYLOAD\u001b\\ \u001b]52;c;Y2xpcA==\u0007",
      }),
    });
    registerParentTool(harness.port, harness.runtime);

    await expect(
      harness.tool.execute(
        "call-1",
        { tasks: [{ agent: "alpha", task: "Inspect" }] },
        undefined,
        undefined,
        executeContext(undefined),
      ),
    ).rejects.toThrow("InvalidSubagentInput (request): invalid");
    const displayed = await harness.tool
      .execute(
        "call-2",
        { tasks: [{ agent: "alpha", task: "Inspect" }] },
        undefined,
        undefined,
        executeContext(undefined),
      )
      .then(
        () => "unexpected success",
        (error: unknown) => (error instanceof Error ? error.message : ""),
      );
    expect(displayed).not.toContain("APC-PAYLOAD");
    expect(displayed).not.toContain("Y2xpcA==");
    expect(displayed.trim()).toBe("InvalidSubagentInput (request): invalid");
  });

  it("disposes the parent managed runtime idempotently on session shutdown", async () => {
    const harness = makeParentHarness();
    registerParentTool(harness.port, harness.runtime);

    await Promise.all([harness.shutdown(), harness.shutdown()]);
    expect(harness.disposeCalls).toBe(1);
  });

  it("allows a padded 500-code-point summary through the registered transport schema", () => {
    let tool: CompletionToolDefinition | undefined;
    registerCompletionTool(
      {
        registerTool: (definition) => {
          tool = definition;
        },
        onSessionShutdown: () => undefined,
      },
      {
        execute: async () => ({
          content: [
            { type: "text", text: "Subagent completion recorded: DONE" },
          ],
          details: { status: "DONE", summary: "Complete" },
          terminate: true,
        }),
        dispose: async () => undefined,
      },
    );
    if (tool === undefined) throw new Error("child adapter did not register");

    const summary = `  ${"😀".repeat(500)}  `;
    expect(Value.Check(tool.parameters, { status: "DONE", summary })).toBe(
      true,
    );
  });

  it("registers only child completion with StringEnum and semantic boundary fields", async () => {
    let tool: CompletionToolDefinition | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    let disposeCalls = 0;
    const execute = vi.fn<CompletionRuntime["execute"]>(async () => ({
      content: [{ type: "text", text: "Subagent completion recorded: DONE" }],
      details: { status: "DONE", summary: "Complete" },
      terminate: true,
    }));
    const runtime: CompletionRuntime = {
      execute,
      dispose: async () => {
        disposeCalls += 1;
      },
    };

    registerCompletionTool(
      {
        registerTool: (definition) => {
          tool = definition;
        },
        onSessionShutdown: (handler) => {
          shutdown = handler;
        },
      },
      runtime,
    );
    if (tool === undefined || shutdown === undefined) {
      throw new Error("child adapter did not register");
    }

    expect(tool.name).toBe("complete_subagent");
    expect(tool.parameters).toMatchObject({
      additionalProperties: false,
      required: ["status", "summary"],
      properties: {
        status: {
          enum: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"],
        },
      },
    });

    const signal = new AbortController().signal;
    const completion = await tool.execute(
      "call-1",
      { status: "DONE", summary: "Complete" },
      signal,
      undefined,
      {},
    );
    expect(execute).toHaveBeenCalledWith(
      { status: "DONE", summary: "Complete" },
      signal,
    );
    expect(completion.terminate).toBe(true);

    await Promise.all([shutdown(), shutdown()]);
    expect(disposeCalls).toBe(1);
  });
});

describe("parent managed runtime lifecycle", () => {
  it("forwards the invocation AbortSignal to a real Effect runner", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finalized = false;
    const batch = {
      execute: () =>
        Effect.acquireUseRelease(
          Effect.sync(markStarted),
          () => Effect.never,
          () =>
            Effect.sync(() => {
              finalized = true;
            }),
        ),
    };
    let receivedSignal: AbortSignal | undefined;
    const runtime = makeParentRuntime(() => {
      const runner = makeEffectRunner(Layer.succeed(SubagentBatch, batch));
      return {
        runPromise: (effect, options) => {
          receivedSignal = options?.signal;
          return runner.runPromise(effect, options);
        },
        dispose: runner.dispose,
      };
    });
    const controller = new AbortController();
    const execution = runtime.execute(parentRuntimeInput(controller.signal));

    await started;
    controller.abort();
    await expect(execution).rejects.toBeDefined();
    expect(receivedSignal).toBe(controller.signal);
    expect(finalized).toBe(true);
    await runtime.dispose();
  });

  it("constructs the default live layer and rejects invalid input before launching", async () => {
    const runtime = makeParentRuntime();
    const input = parentRuntimeInput();

    await expect(
      runtime.execute({ ...input, request: { tasks: [] } }),
    ).rejects.toBeInstanceOf(InvalidSubagentInput);
    await runtime.dispose();
  });

  it("keeps concurrent invocation runners independently owned", async () => {
    const resumes: Array<
      (
        effect: Effect.Effect<{
          readonly results: ReadonlyArray<RunResult>;
          readonly diagnostics: ReadonlyArray<string>;
        }>,
      ) => void
    > = [];
    const disposalCalls = [0, 0];
    let runnerIndex = 0;
    const runtime = makeParentRuntime(() => {
      const index = runnerIndex;
      runnerIndex += 1;
      const batch = {
        execute: () =>
          Effect.async<{
            readonly results: ReadonlyArray<RunResult>;
            readonly diagnostics: ReadonlyArray<string>;
          }>((resume) => {
            resumes[index] = resume;
          }),
      };
      const runner = makeEffectRunner(Layer.succeed(SubagentBatch, batch));
      return {
        runPromise: (effect, options) => runner.runPromise(effect, options),
        dispose: async () => {
          disposalCalls[index] = (disposalCalls[index] ?? 0) + 1;
          await runner.dispose();
        },
      };
    });

    const first = runtime.execute(parentRuntimeInput());
    const second = runtime.execute(parentRuntimeInput());
    await vi.waitFor(() => expect(resumes).toHaveLength(2));

    resumes[0]?.(Effect.succeed({ results: [finalResult], diagnostics: [] }));
    await expect(first).resolves.toEqual({
      results: [finalResult],
      diagnostics: [],
    });
    expect(disposalCalls).toEqual([1, 0]);

    resumes[1]?.(Effect.succeed({ results: [finalResult], diagnostics: [] }));
    await expect(second).resolves.toEqual({
      results: [finalResult],
      diagnostics: [],
    });
    expect(disposalCalls).toEqual([1, 1]);
    await runtime.dispose();
  });

  it("makes session shutdown idempotent while racing active invocations", async () => {
    let starts = 0;
    let markBothStarted: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    let finalizers = 0;
    const runtime = makeParentRuntime(() => {
      const batch = {
        execute: () =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              starts += 1;
              if (starts === 2) markBothStarted();
            }),
            () => Effect.never,
            () =>
              Effect.sync(() => {
                finalizers += 1;
              }),
          ),
      };
      return makeEffectRunner(Layer.succeed(SubagentBatch, batch));
    });
    let sessionShutdown: (() => Promise<void>) | undefined;
    registerParentTool(
      {
        registerTool: () => undefined,
        onSessionShutdown: (handler) => {
          sessionShutdown = handler;
        },
        getThinkingLevel: () => "high",
        getActiveTools: () => [],
        getAllTools: () => [],
      },
      runtime,
    );
    if (sessionShutdown === undefined) {
      throw new Error("session shutdown handler not registered");
    }

    const first = runtime.execute(parentRuntimeInput()).then(
      () => undefined,
      (error: unknown) => error,
    );
    const second = runtime.execute(parentRuntimeInput()).then(
      () => undefined,
      (error: unknown) => error,
    );

    await bothStarted;
    const firstShutdown = sessionShutdown();
    const secondShutdown = sessionShutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.every((outcome) => outcome !== undefined)).toBe(true);
    expect(finalizers).toBe(2);
    await expect(runtime.execute(parentRuntimeInput())).rejects.toThrow(
      "Subagent runtime is shut down",
    );
  });
});
