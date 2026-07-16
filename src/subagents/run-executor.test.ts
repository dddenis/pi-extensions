import { describe, it } from "@effect/vitest";
import {
  Data,
  Deferred,
  Duration,
  Effect,
  Either,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
  TestClock,
} from "effect";
import { expect } from "vitest";
import { EnvironmentServiceTest } from "../../test/services/environment";
import {
  ProcessServiceTest,
  type ProcessServiceTestService,
} from "../../test/services/process";
import {
  ProcessError,
  ProcessService,
  type ProcessService as ProcessServiceShape,
} from "../services/process";
import { RunStoreError } from "./errors";
import type { ResolvedTask } from "./preflight";
import type { ChildProgress } from "./progress";
import {
  RunExecutor,
  type RunExecutorConfig,
  type RunHandle,
} from "./run-executor";
import {
  INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
  type ActiveRunStore,
} from "./run-store";
import {
  decodeRunStatusRecord,
  type RunArtifacts,
  type RunResult,
  type RunStatusRecord,
} from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";

class ProgressTestError extends Data.TaggedError("ProgressTestError")<{
  readonly message: string;
}> {}

const artifacts: RunArtifacts = {
  runId: "run-1",
  runDirectory: "/runs/run-1",
  manifestPath: "/runs/run-1/run.json",
  taskPath: "/runs/run-1/task.md",
  systemPromptPath: "/runs/run-1/system-prompt.md",
  eventsPath: "/runs/run-1/events.jsonl",
  stderrPath: "/runs/run-1/stderr.log",
  statusPath: "/runs/run-1/status.json",
};

const resolvedTask: ResolvedTask = {
  index: 0,
  task: "Inspect private source without exposing it.",
  cwd: "/repo",
  agent: {
    name: "alpha",
    description: "Inspect source",
    rolePrompt: "Inspect private source carefully.",
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    source: "global",
    definitionPath: "/agents/alpha.md",
  },
  toolInheritance: Object.freeze({
    parentActiveToolNames: Object.freeze(["read"]),
    effectiveToolNames: Object.freeze(["read", "complete_subagent"]),
    providerExtensions: Object.freeze(["/extensions/read.ts"]),
    diagnostics: Object.freeze([]),
  }),
};

interface FakeRunState {
  readonly status: RunStatusRecord;
  readonly transitions: ReadonlyArray<RunStatusRecord>;
  readonly events: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
  readonly eventAppendCount: number;
  readonly stderrAppendCount: number;
}

interface FakeRun {
  readonly store: ActiveRunStore;
  readonly state: Effect.Effect<FakeRunState>;
}

const makeFakeRun = (options?: {
  readonly failTransition?: (
    record: RunStatusRecord,
    attempt: number,
  ) => boolean;
  readonly failAppendEvent?: boolean;
  readonly failAppendStderr?: boolean;
  readonly failureMessage?: string;
}): Effect.Effect<FakeRun> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<FakeRunState>({
      status: { status: "STARTING", updatedAt: "2026-07-12T00:00:00.000Z" },
      transitions: [],
      events: [],
      stderr: [],
      eventAppendCount: 0,
      stderrAppendCount: 0,
    });
    const transitionAttempt = yield* Ref.make(0);
    const failure = (operation: string): RunStoreError =>
      new RunStoreError({
        operation,
        path: artifacts.statusPath,
        runId: artifacts.runId,
        message: options?.failureMessage ?? `${operation} failed`,
      });

    const store: ActiveRunStore = {
      artifacts,
      transition: (record) =>
        Ref.getAndUpdate(transitionAttempt, (attempt) => attempt + 1).pipe(
          Effect.flatMap((attempt) =>
            options?.failTransition?.(record, attempt) === true
              ? Effect.fail(failure("transition"))
              : Ref.modify(state, (current) => {
                  const terminal = !["STARTING", "RUNNING"].includes(
                    current.status.status,
                  );
                  return terminal
                    ? [false, current]
                    : [
                        true,
                        {
                          ...current,
                          status: { ...record },
                          transitions: [...current.transitions, { ...record }],
                        },
                      ];
                }),
          ),
        ),
      readStatus: Ref.get(state).pipe(Effect.map((value) => value.status)),
      appendEvent: (rawLine) =>
        Ref.update(state, (current) => ({
          ...current,
          eventAppendCount: current.eventAppendCount + 1,
        })).pipe(
          Effect.zipRight(
            options?.failAppendEvent === true
              ? Effect.fail(failure("appendEvent"))
              : Ref.update(state, (current) => ({
                  ...current,
                  events: [...current.events, rawLine],
                })),
          ),
        ),
      appendStderr: (chunk) =>
        Ref.update(state, (current) => ({
          ...current,
          stderrAppendCount: current.stderrAppendCount + 1,
        })).pipe(
          Effect.zipRight(
            options?.failAppendStderr === true
              ? Effect.fail(failure("appendStderr"))
              : Ref.update(state, (current) => ({
                  ...current,
                  stderr: [...current.stderr, chunk],
                })),
          ),
        ),
    };

    return { store, state: Ref.get(state) };
  });

const usage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens: 10,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.5,
  },
};

const assistantEnd = (options?: {
  readonly stopReason?: "toolUse" | "error" | "aborted";
  readonly errorMessage?: string;
}) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content:
      options?.stopReason === "error" || options?.stopReason === "aborted"
        ? []
        : [
            {
              type: "toolCall",
              id: "completion-1",
              name: "complete_subagent",
              arguments: {},
            },
          ],
    usage,
    stopReason: options?.stopReason ?? "toolUse",
    ...(options?.errorMessage === undefined
      ? {}
      : { errorMessage: options.errorMessage }),
  },
});

const completionEvents = (status = "DONE", summary = "Review complete") => [
  assistantEnd(),
  {
    type: "tool_execution_start",
    toolCallId: "completion-1",
    toolName: "complete_subagent",
    args: { status },
  },
  {
    type: "tool_execution_end",
    toolCallId: "completion-1",
    toolName: "complete_subagent",
    result: {
      content: [
        { type: "text", text: `Subagent completion recorded: ${status}` },
      ],
      details: { status, summary, reportPath: "/tmp/report.md" },
      terminate: true,
    },
    isError: false,
  },
  { type: "agent_settled" },
];

const agentEnd = (willRetry: boolean) => ({
  type: "agent_end",
  messages: [],
  willRetry,
});

const recoveredCompletionEvents = () => {
  const completion = completionEvents();
  const completionAssistant = completion[0];
  const completionTail = completion.slice(1, -1);
  return [
    assistantEnd({
      stopReason: "error",
      errorMessage: "WebSocket error",
    }),
    agentEnd(true),
    {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: "WebSocket error",
    },
    completionAssistant,
    { type: "auto_retry_end", success: true, attempt: 1 },
    ...completionTail,
    agentEnd(false),
    { type: "agent_settled" },
  ];
};

const executorConfig: RunExecutorConfig = {
  completionEntrypoint: "/repo/src/subagents/index.ts",
  executableSelector: () => ({ command: "/compiled/pi", prefix: [] }),
  shutdownPolicy: {
    stdinCloseTimeout: 0,
    gracefulTimeout: 0,
    forcedTimeout: 0,
    totalTimeout: 0,
  },
  postExitDrainTimeout: Duration.seconds(1),
};

const executorLayer = ProcessServiceTest.layer({ manualLaunch: true }).pipe(
  Layer.merge(EnvironmentServiceTest.layer({ values: { HOME: "/home/test" } })),
  (infrastructure) =>
    Layer.merge(
      infrastructure,
      RunExecutor.layer(executorConfig).pipe(Layer.provide(infrastructure)),
    ),
);

const immediateSpawnFailureLayer = (() => {
  const processLayer = Layer.succeed(ProcessService, {
    spawnScoped: () =>
      Effect.fail(
        new ProcessError({ operation: "spawn", message: "spawn rejected" }),
      ),
    spawnDetached: () => Effect.void,
  } satisfies ProcessServiceShape);
  const infrastructure = Layer.merge(
    processLayer,
    EnvironmentServiceTest.layer({ values: { HOME: "/home/test" } }),
  );
  return Layer.merge(
    infrastructure,
    RunExecutor.layer(executorConfig).pipe(Layer.provide(infrastructure)),
  );
})();

const emitLines = (
  process: ProcessServiceTestService,
  index: number,
  values: ReadonlyArray<unknown>,
): Effect.Effect<void> =>
  Effect.forEach(
    values,
    (value) => process.emitStdout(index, JSON.stringify(value)),
    { discard: true },
  );

const eventually = <A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = yield* effect;
      if (predicate(value)) return value;
      yield* Effect.yieldNow();
    }
    return yield* Effect.die(new Error("condition did not become true"));
  });

const launchRun = (
  run: ActiveRunStore,
  onProgress: (progress: ChildProgress) => Effect.Effect<void, unknown> = () =>
    Effect.void,
): Effect.Effect<
  RunHandle,
  import("./errors").SubagentError,
  RunExecutor | Scope.Scope
> =>
  Effect.gen(function* () {
    const executor = yield* RunExecutor;
    return yield* executor.launch(resolvedTask, run, onProgress);
  });

describe("RunExecutor", () => {
  it.effect(
    "creates the scoped process and returns a handle before launch confirmation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);
          const launchedFiber = yield* Effect.fork(handle.launched);

          const before = yield* process.getState;
          expect(before.managedSpawnCount).toBe(1);
          expect(before.stdinEndCount).toBe(1);
          expect(Option.isNone(yield* Fiber.poll(launchedFiber))).toBe(true);
          expect(before.calls[0]).toEqual({
            command: "/compiled/pi",
            args: [
              "--mode",
              "json",
              "--print",
              "--no-session",
              "--no-extensions",
              "--extension",
              "/repo/src/subagents/index.ts",
              "--extension",
              "/extensions/read.ts",
              "--model",
              "openai-codex/gpt-5.4",
              "--thinking",
              "high",
              "--tools",
              "read,complete_subagent",
              "--append-system-prompt",
              artifacts.systemPromptPath,
              `@${artifacts.taskPath}`,
            ],
            options: {
              cwd: "/repo",
              env: { HOME: "/home/test", PI_SUBAGENT_CHILD: "1" },
              stdio: "pipe",
            },
          });

          yield* process.emitLaunch(0);
          yield* Fiber.join(launchedFiber);
          expect((yield* run.state).status.status).toBe("RUNNING");
          yield* process.complete(0, { code: 0, signal: null });
          expect((yield* handle.awaitResult).status).toBe("FAILED");
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "defers terminal commitment until awaitResult opens the replayable gate",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);

          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* emitLines(process, 0, completionEvents());
          yield* process.complete(0, { code: 0, signal: null });
          yield* eventually(
            process.getState,
            (state) =>
              state.processes[0]?.lifecycleEvents.includes("stderr-stopped") ===
              true,
          );
          yield* Effect.forEach(
            Array.from({ length: 20 }),
            () => Effect.yieldNow(),
            { discard: true },
          );

          expect((yield* run.state).status.status).toBe("RUNNING");
          expect((yield* handle.awaitResult).status).toBe("DONE");
          expect((yield* handle.awaitResult).status).toBe("DONE");
          expect((yield* run.state).status.status).toBe("DONE");
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "publishes launched immediately after RUNNING without waiting for blocked progress",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const callbackStarted = yield* Deferred.make<void>();
          const handle = yield* launchRun(run.store, () =>
            Deferred.succeed(callbackStarted, undefined).pipe(
              Effect.zipRight(Effect.never),
            ),
          );

          yield* process.emitLaunch(0);
          yield* handle.launched;
          expect((yield* run.state).status.status).toBe("RUNNING");
          yield* Deferred.await(callbackStarted);
          yield* emitLines(process, 0, completionEvents());
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          expect(result.status).toBe("DONE");
          expect(result.diagnostics).toEqual([]);
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "contains typed progress failures and defects as best-effort diagnostics",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* ProcessServiceTest;
          const cases = [
            {
              name: "typed failure",
              callback: () =>
                Effect.fail(
                  new ProgressTestError({ message: "progress rejected" }),
                ),
              diagnostic: "Progress callback failed: progress rejected",
            },
            {
              name: "defect",
              callback: () => Effect.die(new Error("progress defect")),
              diagnostic: "Progress callback defect: progress defect",
            },
          ] as const;

          for (const [index, testCase] of cases.entries()) {
            const run = yield* makeFakeRun();
            const callbackAttempted = yield* Deferred.make<void>();
            const handle = yield* launchRun(run.store, () =>
              Deferred.succeed(callbackAttempted, undefined).pipe(
                Effect.zipRight(testCase.callback()),
              ),
            );
            yield* process.emitLaunch(index);
            yield* handle.launched;
            yield* Deferred.await(callbackAttempted);
            yield* emitLines(process, index, completionEvents());
            yield* process.complete(index, { code: 0, signal: null });

            const result = yield* handle.awaitResult;
            expect(result.status, testCase.name).toBe("DONE");
            expect(result.diagnostics, testCase.name).toContain(
              testCase.diagnostic,
            );
            expect((yield* run.state).status.status, testCase.name).toBe(
              "DONE",
            );
          }
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect("contains a synchronous throw from initial progress delivery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* makeFakeRun();
        const process = yield* ProcessServiceTest;
        const handle = yield* launchRun(run.store, () => {
          throw new Error("initial progress throw");
        });

        yield* process.emitLaunch(0);
        yield* handle.launched;
        yield* emitLines(process, 0, completionEvents());
        yield* process.complete(0, { code: 0, signal: null });

        const result = yield* handle.awaitResult;
        expect(result.status).toBe("DONE");
        expect(result.diagnostics).toContain(
          "Progress callback defect: initial progress throw",
        );
        expect((yield* run.state).status.status).toBe("DONE");
      }),
    ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "contains a synchronous throw from event-driven progress delivery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          let calls = 0;
          let initialCompleted = false;
          const handle = yield* launchRun(run.store, () => {
            calls += 1;
            if (calls > 1) throw new Error("event progress throw");
            return Effect.sync(() => {
              initialCompleted = true;
            });
          });

          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* eventually(
            Effect.sync(() => initialCompleted),
            (completed) => completed,
          );
          yield* Effect.yieldNow();
          yield* process.emitStdout(
            0,
            JSON.stringify({ type: "session", id: "session-1" }),
          );
          yield* emitLines(process, 0, completionEvents());
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          expect(result.status).toBe("DONE");
          expect(result.diagnostics).toContain(
            "Progress callback defect: event progress throw",
          );
          expect(calls).toBeGreaterThan(1);
          expect((yield* run.state).status.status).toBe("DONE");
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "drains stdout and stderr concurrently, appends raw data first, and returns semantic completion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const progress = yield* Ref.make<ReadonlyArray<ChildProgress>>([]);
          const handle = yield* launchRun(run.store, (snapshot) =>
            Ref.update(progress, (items) => [...items, snapshot]),
          );

          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* process.emitStdout(
            0,
            JSON.stringify({ type: "session", id: "session-1" }),
          );
          yield* process.emitStderr(0, "warning\npartial");
          yield* emitLines(process, 0, completionEvents());
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          const state = yield* run.state;
          expect(result).toMatchObject({
            runId: "run-1",
            agent: "alpha",
            status: "DONE",
            summary: "Review complete",
            reportPath: "/tmp/report.md",
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
            artifacts,
            diagnostics: [],
          });
          expect(state.events).toEqual(
            [{ type: "session", id: "session-1" }, ...completionEvents()].map(
              (event) => `${JSON.stringify(event)}\n`,
            ),
          );
          expect(state.stderr).toEqual(["warning\npartial"]);
          expect(state.transitions.map(({ status }) => status)).toEqual([
            "RUNNING",
            "DONE",
          ]);
          const snapshots = yield* Ref.get(progress);
          expect(snapshots.length).toBeGreaterThan(0);
          expect(JSON.stringify(snapshots)).not.toContain(resolvedTask.task);
          expect(JSON.stringify(snapshots)).not.toContain(
            resolvedTask.agent.rolePrompt,
          );
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "durably commits semantic completion with a recovered provider diagnostic",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);

          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* emitLines(process, 0, recoveredCompletionEvents());
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          const persisted = (yield* run.state).status;
          expect(result).toMatchObject({
            status: "DONE",
            summary: "Review complete",
            reportPath: "/tmp/report.md",
            exitCode: 0,
            signal: null,
            diagnostics: [
              "Recovered provider retry attempt 1: WebSocket error",
            ],
          });
          expect(persisted).toMatchObject({
            status: "DONE",
            summary: "Review complete",
            reportPath: "/tmp/report.md",
            diagnostics: [
              "Recovered provider retry attempt 1: WebSocket error",
            ],
          });
          expect(() => decodeRunStatusRecord(persisted)).not.toThrow();
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "retains recovered diagnostics when a later process failure wins",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);

          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* emitLines(process, 0, recoveredCompletionEvents());
          yield* process.emitPostLaunchError(
            0,
            new ProcessError({
              operation: "wait",
              message: "late process failure",
            }),
          );
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          const persisted = (yield* run.state).status;
          expect(result.status).toBe("FAILED");
          expect(result.diagnostics).toContain(
            "Recovered provider retry attempt 1: WebSocket error",
          );
          expect(result.diagnostics.join(" ")).toContain(
            "late process failure",
          );
          expect(persisted.status).toBe("FAILED");
          expect(persisted.diagnostics).toContain(
            "Recovered provider retry attempt 1: WebSocket error",
          );
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "preserves delayed tail output that drains after the direct exit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);

          yield* process.emitLaunch(0);
          yield* handle.launched;
          const resultFiber = yield* Effect.fork(handle.awaitResult);
          yield* process.emitExit(0, { code: 0, signal: null });
          yield* Effect.yieldNow();
          yield* emitLines(process, 0, completionEvents());
          yield* process.emitOutputEnd(0);

          const result = yield* Fiber.join(resultFiber);
          expect(result.status).toBe("DONE");
          expect(result.summary).toBe("Review complete");
          expect((yield* run.state).events).toEqual(
            completionEvents().map((event) => `${JSON.stringify(event)}\n`),
          );
          expect((yield* process.getState).outputCloseCount).toBe(1);
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "fails and releases local output when descriptors remain open after exit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);

          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* emitLines(process, 0, completionEvents());
          const resultFiber = yield* Effect.fork(handle.awaitResult);
          yield* process.emitExit(0, { code: 0, signal: null });
          yield* TestClock.adjust(Duration.seconds(1));

          const result = yield* Fiber.join(resultFiber);
          const processState = yield* process.getState;
          expect(result.status).toBe("FAILED");
          expect(result.exitCode).toBe(0);
          expect(result.signal).toBeNull();
          expect(result.diagnostics).toContain(
            "Process output did not drain after exit; retained evidence may be truncated",
          );
          expect(processState.outputCloseCount).toBe(1);
          expect(processState.processes[0]?.lifecycleEvents).toEqual(
            expect.arrayContaining([
              "output-closed",
              "stdout-stopped",
              "stderr-stopped",
            ]),
          );
          expect((yield* run.state).status.status).toBe("FAILED");
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect("shuts down and fails when stdout fails before process exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* makeFakeRun();
        const process = yield* ProcessServiceTest;
        const handle = yield* launchRun(run.store);

        yield* process.emitLaunch(0);
        yield* handle.launched;
        const resultFiber = yield* Effect.fork(handle.awaitResult);
        yield* process.emitStdoutFailure(
          0,
          new ProcessError({
            operation: "stream",
            message: "stdout record exceeded 4 bytes",
            reason: "record-too-large",
            stream: "stdout",
            limitBytes: 4,
            observedBytes: 5,
          }),
        );

        const processState = yield* eventually(
          process.getState,
          (state) => state.signals.length === 2,
        );
        const result = yield* Fiber.join(resultFiber);
        expect(result.status).toBe("FAILED");
        expect(result.exitCode).toBeNull();
        expect(result.diagnostics.join(" ")).toContain(
          "stdout record exceeded 4 bytes",
        );
        expect(processState.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(processState.outputCloseCount).toBe(1);
        expect((yield* run.state).status.status).toBe("FAILED");
      }),
    ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "fails valid completion at exit zero when a post-launch process error was recorded",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);

          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* emitLines(process, 0, completionEvents());
          yield* process.emitPostLaunchError(
            0,
            new ProcessError({
              operation: "wait",
              message: "late process error",
            }),
          );
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          expect(result.status).toBe("FAILED");
          expect(result.exitCode).toBe(0);
          expect(result.diagnostics.join(" ")).toContain("late process error");
          expect((yield* run.state).status.status).toBe("FAILED");
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "sanitizes failure summaries while retaining raw control-bearing diagnostics",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const controls =
            "\u001b[31mCSI\u001b[0m BEL\u0007 C1\u0085 " +
            "\u001b_APC-PAYLOAD\u001b\\ " +
            "\u001b]52;c;T1NDLTUyLUNMSVBCT0FSRA==\u0007";
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);

          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* emitLines(process, 0, completionEvents());
          yield* process.emitPostLaunchError(
            0,
            new ProcessError({
              operation: "wait",
              message: `provider failed ${controls}`,
            }),
          );
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          const persisted = (yield* run.state).status;
          expect(result.status).toBe("FAILED");
          expect(result.summary).toBe(sanitizeTerminalText(result.summary));
          expect(persisted.status).toBe("FAILED");
          expect(persisted.summary).toBe(
            sanitizeTerminalText(persisted.summary ?? ""),
          );
          expect(result.diagnostics.join(" ")).toContain(controls);
          expect(persisted.diagnostics?.join(" ")).toContain(controls);
          expect(() => decodeRunStatusRecord(persisted)).not.toThrow();
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect("maps every invalid terminal event/process outcome to FAILED", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* ProcessServiceTest;
        const cases: ReadonlyArray<{
          readonly name: string;
          readonly lines: ReadonlyArray<unknown | string>;
          readonly exit: { code: number | null; signal: NodeJS.Signals | null };
          readonly diagnostic: string;
        }> = [
          {
            name: "missing completion",
            lines: [{ type: "agent_settled" }],
            exit: { code: 0, signal: null },
            diagnostic: "no valid structured completion",
          },
          {
            name: "provider error",
            lines: [
              assistantEnd({
                stopReason: "error",
                errorMessage: "provider unavailable",
              }),
              { type: "agent_settled" },
            ],
            exit: { code: 0, signal: null },
            diagnostic: "provider unavailable",
          },
          {
            name: "malformed JSON",
            lines: ["{not-json", { type: "agent_settled" }],
            exit: { code: 0, signal: null },
            diagnostic: "malformed events",
          },
          {
            name: "invalidated completion",
            lines: [
              ...completionEvents(),
              { type: "message_start", message: { role: "assistant" } },
              { type: "agent_settled" },
            ],
            exit: { code: 0, signal: null },
            diagnostic: "invalidated",
          },
          {
            name: "nonzero exit",
            lines: completionEvents(),
            exit: { code: 7, signal: null },
            diagnostic: "code 7",
          },
          {
            name: "signal exit",
            lines: completionEvents(),
            exit: { code: null, signal: "SIGTERM" },
            diagnostic: "signal SIGTERM",
          },
        ];

        for (const [index, testCase] of cases.entries()) {
          const run = yield* makeFakeRun();
          const handle = yield* launchRun(run.store);
          yield* process.emitLaunch(index);
          yield* handle.launched;
          for (const value of testCase.lines) {
            yield* process.emitStdout(
              index,
              typeof value === "string" ? value : JSON.stringify(value),
            );
          }
          yield* process.complete(index, testCase.exit);
          const result = yield* handle.awaitResult;
          expect(result.status, testCase.name).toBe("FAILED");
          expect(result.diagnostics.join(" "), testCase.name).toContain(
            testCase.diagnostic,
          );
          expect((yield* run.state).status.status, testCase.name).toBe(
            "FAILED",
          );
        }
      }),
    ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "records a synchronous spawn failure before returning the launch error",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const result = yield* Effect.either(launchRun(run.store));

          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result)) {
            expect(result.left).toMatchObject({
              _tag: "ChildProcessError",
              operation: "spawn",
              message: "spawn rejected",
            });
          }
          expect((yield* run.state).status.status).toBe("FAILED");
          expect((yield* run.state).transitions[0]?.diagnostics).toContain(
            "infrastructure-rollback",
          );
        }),
      ).pipe(Effect.provide(immediateSpawnFailureLayer)),
  );

  it.effect(
    "preserves rollback marking when a startup FAILED transition needs fallback",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun({
            failTransition: (record, attempt) =>
              record.status === "FAILED" &&
              (attempt === 0 ||
                record.diagnostics?.includes(
                  INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
                ) !== true),
          });
          const result = yield* Effect.either(launchRun(run.store));

          expect(Either.isLeft(result)).toBe(true);
          expect((yield* run.state).status.status).toBe("FAILED");
          expect((yield* run.state).status.diagnostics).toContain(
            INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
          );
          expect((yield* run.state).status.diagnostics?.join(" ")).toContain(
            "spawn rejected",
          );
        }),
      ).pipe(Effect.provide(immediateSpawnFailureLayer)),
  );

  it.effect(
    "records launch failure durably while launched retains a process diagnostic",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun();
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);
          yield* process.emitLaunchFailure(
            0,
            new ProcessError({ operation: "spawn", message: "not found" }),
          );

          const launched = yield* Effect.either(handle.launched);
          expect(Either.isLeft(launched)).toBe(true);
          if (Either.isLeft(launched)) {
            expect(launched.left).toMatchObject({
              _tag: "ChildProcessError",
              operation: "spawn",
              message: "not found",
            });
          }
          const publishedState = yield* run.state;
          expect(publishedState.status.status).toBe("FAILED");
          expect(publishedState.status.diagnostics).toContain(
            INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
          );
          const result = yield* handle.awaitResult;
          expect(result.status).toBe("FAILED");
          expect(result.diagnostics.join(" ")).toContain("not found");
          expect((yield* run.state).status.status).toBe("FAILED");
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "records marked FAILED before publishing a RUNNING transition launch-barrier failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun({
            failTransition: (record) => record.status === "RUNNING",
          });
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);
          yield* process.emitLaunch(0);

          const launched = yield* Effect.either(handle.launched);
          expect(Either.isLeft(launched)).toBe(true);
          const state = yield* run.state;
          expect(state.status.status).toBe("FAILED");
          expect(state.status.diagnostics).toContain(
            INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
          );
          expect((yield* handle.awaitResult).status).toBe("FAILED");
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "continues sustained stdout and stderr consumption after append failures",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* ProcessServiceTest;
          const cases = [
            {
              name: "stdout append failure",
              options: { failAppendEvent: true },
              expectedDiagnostic: "appendEvent failed",
            },
            {
              name: "stderr append failure",
              options: { failAppendStderr: true },
              expectedDiagnostic: "appendStderr failed",
            },
          ] as const;

          for (const [index, testCase] of cases.entries()) {
            const run = yield* makeFakeRun(testCase.options);
            const handle = yield* launchRun(run.store);
            yield* process.emitLaunch(index);
            yield* handle.launched;
            yield* emitLines(process, index, completionEvents());
            for (let item = 0; item < 128; item += 1) {
              yield* process.emitStdout(
                index,
                JSON.stringify({ type: "unknown", item }),
              );
              yield* process.emitStderr(index, `diagnostic-${String(item)}\n`);
            }
            yield* process.complete(index, { code: 0, signal: null });

            const result = yield* handle.awaitResult;
            const state = yield* run.state;
            expect(result.status, testCase.name).toBe("FAILED");
            expect(result.diagnostics.join(" "), testCase.name).toContain(
              testCase.expectedDiagnostic,
            );
            expect(state.eventAppendCount, testCase.name).toBe(132);
            expect(state.stderrAppendCount, testCase.name).toBe(128);
          }
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "turns a stream store failure into FAILED when the terminal write is recordable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun({ failAppendEvent: true });
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);
          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* process.emitStdout(
            0,
            JSON.stringify({ type: "agent_settled" }),
          );
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          expect(result.status).toBe("FAILED");
          expect(result.diagnostics.join(" ")).toContain("appendEvent failed");
          expect((yield* run.state).status.status).toBe("FAILED");
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "falls back to FAILED after a semantic terminal store failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun({
            failTransition: (record) => record.status === "DONE",
          });
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);
          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* emitLines(process, 0, completionEvents());
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          expect(result.status).toBe("FAILED");
          expect(result.diagnostics.join(" ")).toContain("transition failed");
          expect((yield* run.state).status.status).toBe("FAILED");
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "preserves store diagnostics while bounding the model-facing failure summary",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const diagnostic = `private failure ${"detail ".repeat(100)}`.trim();
          const run = yield* makeFakeRun({
            failTransition: (record) => record.status === "DONE",
            failureMessage: diagnostic,
          });
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);
          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* emitLines(process, 0, completionEvents());
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* handle.awaitResult;
          expect(result.status).toBe("FAILED");
          expect(Array.from(result.summary)).toHaveLength(500);
          expect(result.diagnostics).toEqual([
            `RunStoreError transition: ${diagnostic}`,
          ]);
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "fails explicitly with RunStoreError when no terminal outcome can be recorded",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeFakeRun({
            failTransition: (record) =>
              record.status === "DONE" || record.status === "FAILED",
          });
          const process = yield* ProcessServiceTest;
          const handle = yield* launchRun(run.store);
          yield* process.emitLaunch(0);
          yield* handle.launched;
          yield* emitLines(process, 0, completionEvents());
          yield* process.complete(0, { code: 0, signal: null });

          const result = yield* Effect.either(handle.awaitResult);
          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result)) {
            expect(result.left).toMatchObject({
              _tag: "RunStoreError",
              operation: "transition",
            });
          }
        }),
      ).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "preserves cancellation transition failure diagnostics before launch acknowledgement",
    () =>
      Effect.gen(function* () {
        const run = yield* makeFakeRun({
          failTransition: (record) => record.status === "ABORTED",
        });
        const ready = yield* Deferred.make<RunHandle>();
        const fiber = yield* Effect.fork(
          Effect.scoped(
            launchRun(run.store).pipe(
              Effect.tap((handle) => Deferred.succeed(ready, handle)),
              Effect.flatMap((handle) => handle.awaitResult),
            ),
          ),
        );
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(fiber);

        const state = yield* run.state;
        expect(state.status.status).toBe("STARTING");
        expect(state.stderr.join("")).toContain(
          "Unable to record ABORTED: RunStoreError transition: transition failed",
        );
      }).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "preserves cancellation transition failure diagnostics after launch acknowledgement",
    () =>
      Effect.gen(function* () {
        const run = yield* makeFakeRun({
          failTransition: (record) => record.status === "ABORTED",
        });
        const process = yield* ProcessServiceTest;
        const ready = yield* Deferred.make<RunHandle>();
        const fiber = yield* Effect.fork(
          Effect.scoped(
            launchRun(run.store).pipe(
              Effect.tap((handle) => Deferred.succeed(ready, handle)),
              Effect.flatMap((handle) => handle.awaitResult),
            ),
          ),
        );
        const handle = yield* Deferred.await(ready);
        yield* process.emitLaunch(0);
        yield* handle.launched;
        yield* Fiber.interrupt(fiber);

        const state = yield* run.state;
        expect(state.status.status).toBe("RUNNING");
        expect(state.stderr.join("")).toContain(
          "Unable to record ABORTED: RunStoreError transition: transition failed",
        );
      }).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "closes the process scope and commits ABORTED on interruption",
    () =>
      Effect.gen(function* () {
        const run = yield* makeFakeRun();
        const process = yield* ProcessServiceTest;
        const ready = yield* Deferred.make<RunHandle>();
        const fiber = yield* Effect.fork(
          Effect.scoped(
            launchRun(run.store).pipe(
              Effect.tap((handle) => Deferred.succeed(ready, handle)),
              Effect.flatMap((handle) => handle.awaitResult),
            ),
          ),
        );
        const handle = yield* Deferred.await(ready);
        yield* process.emitLaunch(0);
        yield* handle.launched;
        yield* Fiber.interrupt(fiber);

        const state = yield* eventually(run.state, (value) =>
          ["ABORTED", "DONE"].includes(value.status.status),
        );
        expect(state.status.status).toBe("ABORTED");
        const processState = yield* process.getState;
        expect(processState.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(processState.outputCloseCount).toBe(1);
      }).pipe(Effect.provide(executorLayer)),
  );

  it.effect(
    "does not overwrite a terminal status when its enclosing scope is later interrupted",
    () =>
      Effect.gen(function* () {
        const run = yield* makeFakeRun();
        const process = yield* ProcessServiceTest;
        const ready = yield* Deferred.make<RunHandle>();
        const completed = yield* Deferred.make<RunResult>();
        const hold = yield* Deferred.make<void>();
        const fiber = yield* Effect.fork(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* launchRun(run.store);
              yield* Deferred.succeed(ready, handle);
              const result = yield* handle.awaitResult;
              yield* Deferred.succeed(completed, result);
              yield* Deferred.await(hold);
            }),
          ),
        );
        const handle = yield* Deferred.await(ready);
        yield* process.emitLaunch(0);
        yield* handle.launched;
        yield* emitLines(process, 0, completionEvents());
        yield* process.complete(0, { code: 0, signal: null });
        expect((yield* Deferred.await(completed)).status).toBe("DONE");
        yield* Fiber.interrupt(fiber);

        const state = yield* run.state;
        expect(state.status.status).toBe("DONE");
        expect(state.transitions.map(({ status }) => status)).toEqual([
          "RUNNING",
          "DONE",
        ]);
      }).pipe(Effect.provide(executorLayer)),
  );
});
