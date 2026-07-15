import { describe, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
} from "effect";
import { expect } from "vitest";
import { EnvironmentServiceTest } from "../../test/services/environment";
import { ProcessServiceTest } from "../../test/services/process";
import { ProcessError } from "../services/process";
import type { AgentDiscovery } from "./agents";
import {
  type BatchOrchestrationPorts,
  type BatchProgress,
  makeSubagentBatch,
} from "./batch";
import {
  ChildProcessError,
  InvalidSubagentInput,
  RunStoreError,
  type SubagentError,
} from "./errors";
import type { ParentSnapshot, ResolvedTask } from "./preflight";
import { makeChildProgress, type ChildProgress } from "./progress";
import {
  RunExecutor,
  type RunExecutor as RunExecutorService,
  type RunHandle,
} from "./run-executor";
import {
  INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
  type ActiveRunStore,
  type RunStore,
} from "./run-store";
import {
  decodeRunStatusRecord,
  type RunArtifacts,
  type RunResult,
  type RunStatusRecord,
  type TerminalStatus,
} from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";

const parent: ParentSnapshot = {
  cwd: "/repo",
  model: "openai/parent",
  thinking: "medium",
  activeToolNames: ["read"],
  toolProviders: [{ name: "read", source: "builtin", path: "<builtin:read>" }],
};

const emptyDiscovery: AgentDiscovery = {
  catalog: { _tag: "Complete" },
  definitions: [],
  diagnostics: [],
};

const task = (
  index: number,
  toolDiagnostics: ReadonlyArray<string> = [],
): ResolvedTask => ({
  index,
  task: `task-${index}`,
  cwd: "/repo",
  agent: {
    name: `agent-${index}`,
    description: "test agent",
    rolePrompt: "Test the requested behavior.",
    model: "openai/test",
    thinking: "medium",
    source: "global",
    definitionPath: `/agents/agent-${index}.md`,
  },
  toolInheritance: Object.freeze({
    parentActiveToolNames: Object.freeze(["read"]),
    effectiveToolNames: Object.freeze(["read", "complete_subagent"]),
    providerExtensions: Object.freeze([]),
    diagnostics: Object.freeze([...toolDiagnostics]),
  }),
});

const requestFor = (tasks: ReadonlyArray<ResolvedTask>): unknown => ({
  tasks: tasks.map((item) => ({ agent: item.agent.name, task: item.task })),
});

const artifactsFor = (index: number): RunArtifacts => ({
  runId: `run-${index}`,
  runDirectory: `/runs/run-${index}`,
  manifestPath: `/runs/run-${index}/run.json`,
  taskPath: `/runs/run-${index}/task.md`,
  systemPromptPath: `/runs/run-${index}/system-prompt.md`,
  eventsPath: `/runs/run-${index}/events.jsonl`,
  stderrPath: `/runs/run-${index}/stderr.log`,
  statusPath: `/runs/run-${index}/status.json`,
});

const resultFor = (
  item: ResolvedTask,
  status: TerminalStatus = "DONE",
): RunResult => ({
  runId: `run-${item.index}`,
  agent: item.agent.name,
  status,
  summary: `${status.toLowerCase()}-${item.index}`,
  exitCode: status === "FAILED" ? 1 : 0,
  signal: null,
  usage: {
    input: item.index,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
  },
  artifacts: artifactsFor(item.index),
  diagnostics: status === "FAILED" ? ["child failed"] : [],
});

interface FakeRun {
  readonly store: ActiveRunStore;
  readonly status: Effect.Effect<RunStatusRecord>;
  readonly transitions: Effect.Effect<ReadonlyArray<RunStatusRecord>>;
}

const makeFakeRun = (
  index: number,
  events: Array<string>,
  failRollbackMessage?: string,
): Effect.Effect<FakeRun> =>
  Effect.gen(function* () {
    const status = yield* Ref.make<RunStatusRecord>({
      status: "STARTING",
      updatedAt: "2026-07-12T00:00:00.000Z",
    });
    const transitions = yield* Ref.make<ReadonlyArray<RunStatusRecord>>([]);
    const artifacts = artifactsFor(index);
    const transition: ActiveRunStore["transition"] = (record) =>
      Effect.gen(function* () {
        events.push(`${record.status}-${index}`);
        if (
          record.status === "FAILED" &&
          record.diagnostics?.includes(INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC) ===
            true &&
          failRollbackMessage !== undefined
        ) {
          return yield* new RunStoreError({
            operation: "transition",
            path: artifacts.statusPath,
            runId: artifacts.runId,
            message: failRollbackMessage,
          });
        }
        const current = yield* Ref.get(status);
        if (!["STARTING", "RUNNING"].includes(current.status)) return false;
        yield* Ref.set(status, { ...record });
        yield* Ref.update(transitions, (records) => [
          ...records,
          { ...record },
        ]);
        return true;
      });
    const store: ActiveRunStore = {
      artifacts,
      transition,
      readStatus: Ref.get(status),
      appendEvent: () => Effect.void,
      appendStderr: () => Effect.void,
    };
    return {
      store,
      status: Ref.get(status),
      transitions: Ref.get(transitions),
    };
  });

interface HarnessOptions {
  readonly tasks: ReadonlyArray<ResolvedTask>;
  readonly discovery?: AgentDiscovery;
  readonly create?: (
    item: ResolvedTask,
    run: ActiveRunStore,
  ) => Effect.Effect<ActiveRunStore, RunStoreError>;
  readonly createFailureAt?: number;
  readonly createFailureMessage?: string;
  readonly rollbackFailureAt?: number;
  readonly rollbackFailureMessage?: string;
  readonly executor?: (
    runs: ReadonlyArray<FakeRun>,
    events: Array<string>,
  ) => Effect.Effect<RunExecutor>;
  readonly preflightFailure?: SubagentError;
}

interface Harness {
  readonly batch: ReturnType<typeof makeSubagentBatch>;
  readonly runs: ReadonlyArray<FakeRun>;
  readonly events: Array<string>;
  readonly createCalls: Effect.Effect<number>;
  readonly launchCalls: Effect.Effect<number>;
}

const batchExecutorInfrastructure = ProcessServiceTest.layer({
  manualLaunch: true,
}).pipe(
  Layer.merge(EnvironmentServiceTest.layer({ values: { HOME: "/home/test" } })),
);

const batchExecutorLayer = Layer.merge(
  batchExecutorInfrastructure,
  RunExecutor.layer({
    completionEntrypoint: "/repo/src/subagents/index.ts",
    executableSelector: () => ({ command: "/compiled/pi", prefix: [] }),
    shutdownPolicy: {
      stdinCloseTimeout: 0,
      gracefulTimeout: 0,
      forcedTimeout: 0,
      totalTimeout: 0,
    },
  }).pipe(Layer.provide(batchExecutorInfrastructure)),
);

const batchCompletionEvents = () => [
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "completion-1",
          name: "complete_subagent",
          arguments: {},
        },
      ],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    },
  },
  {
    type: "tool_execution_end",
    toolCallId: "completion-1",
    toolName: "complete_subagent",
    result: {
      content: [{ type: "text", text: "Subagent completion recorded: DONE" }],
      details: { status: "DONE", summary: "finished before barrier" },
      terminate: true,
    },
    isError: false,
  },
  { type: "agent_settled" },
];

const immediateExecutor: RunExecutorService = {
  launch: (item) =>
    Effect.succeed({
      launched: Effect.void,
      awaitResult: Effect.succeed(resultFor(item)),
    }),
};

const makeHarness = (options: HarnessOptions): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const createCalls = yield* Ref.make(0);
    const launchCalls = yield* Ref.make(0);
    const runs = yield* Effect.forEach(options.tasks, (item) =>
      makeFakeRun(
        item.index,
        events,
        options.rollbackFailureAt === item.index
          ? (options.rollbackFailureMessage ?? "rollback status write failed")
          : undefined,
      ),
    );
    const store: RunStore = {
      create: (item) =>
        Ref.update(createCalls, (count) => count + 1).pipe(
          Effect.zipRight(
            options.createFailureAt === item.index
              ? Effect.fail(
                  new RunStoreError({
                    operation: "create",
                    path: `/runs/run-${item.index}`,
                    runId: `run-${item.index}`,
                    message:
                      options.createFailureMessage ??
                      `create-${item.index} failed`,
                  }),
                )
              : Effect.succeed(runs[item.index]?.store),
          ),
          Effect.flatMap((run) => {
            if (run === undefined) {
              return Effect.die(new Error(`Missing fake run ${item.index}`));
            }
            return options.create === undefined
              ? Effect.succeed(run)
              : options.create(item, run);
          }),
        ),
    };
    const configuredExecutor =
      options.executor === undefined
        ? immediateExecutor
        : yield* options.executor(runs, events);
    const executor: RunExecutor = {
      launch: (item, run, onProgress) =>
        Ref.update(launchCalls, (count) => count + 1).pipe(
          Effect.zipRight(configuredExecutor.launch(item, run, onProgress)),
        ),
    };
    const ports: BatchOrchestrationPorts = {
      discover: Effect.succeed(options.discovery ?? emptyDiscovery),
      preflight: () =>
        options.preflightFailure === undefined
          ? Effect.succeed(options.tasks)
          : Effect.fail(options.preflightFailure),
      store,
      executor,
    };
    return {
      batch: makeSubagentBatch(ports),
      runs,
      events,
      createCalls: Ref.get(createCalls),
      launchCalls: Ref.get(launchCalls),
    };
  });

describe("SubagentBatch setup and successful execution", () => {
  it.effect("runs one child", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ tasks: [task(0)] });
      const results = yield* harness.batch.execute(
        requestFor([task(0)]),
        parent,
        () => Effect.void,
      );
      expect(results.results.map((result) => result.runId)).toEqual(["run-0"]);
      expect(yield* harness.createCalls).toBe(1);
      expect(yield* harness.launchCalls).toBe(1);
    }),
  );

  it.effect(
    "retains discovery and tool warnings in progress and the successful batch result",
    () =>
      Effect.gen(function* () {
        const toolWarning =
          'Inherited tool "sdk_bound" omitted: SDK tools cannot be recreated in a child process';
        const item = task(0, [toolWarning]);
        const warning = {
          definitionPath: "/agents/unreadable.md",
          message: "permission denied",
        };
        const observed: Array<BatchProgress> = [];
        const harness = yield* makeHarness({
          tasks: [item],
          discovery: {
            catalog: { _tag: "Indeterminate" },
            definitions: [],
            diagnostics: [warning],
          },
          executor: () =>
            Effect.succeed({
              launch: (launchedTask, _run, onProgress) =>
                onProgress({
                  ...makeChildProgress(
                    `run-${launchedTask.index}`,
                    launchedTask.agent.name,
                  ).snapshot,
                  lifecycle: "RUNNING",
                }).pipe(
                  Effect.ignore,
                  Effect.as({
                    launched: Effect.void,
                    awaitResult: Effect.succeed(resultFor(launchedTask)),
                  }),
                ),
            }),
        });
        const execution = yield* harness.batch.execute(
          requestFor([item]),
          parent,
          (snapshot) =>
            Effect.sync(() => {
              observed.push(snapshot);
            }),
        );

        expect(execution.results.map(({ runId }) => runId)).toEqual(["run-0"]);
        expect(execution.diagnostics).toEqual([
          "agent definition (/agents/unreadable.md): permission denied",
          toolWarning,
        ]);
        expect(observed[0]?.diagnostics).toEqual(execution.diagnostics);
        expect(
          execution.diagnostics.filter((value) => value === toolWarning),
        ).toHaveLength(1);
        expect(
          observed[0]?.diagnostics.filter((value) => value === toolWarning),
        ).toHaveLength(1);
        expect(Object.isFrozen(execution)).toBe(true);
        expect(Object.isFrozen(execution.diagnostics)).toBe(true);
      }),
  );

  it.effect(
    "runs three unrestricted tasks concurrently with observed overlap",
    () =>
      Effect.gen(function* () {
        const active = yield* Ref.make(0);
        const maximum = yield* Ref.make(0);
        const allStarted = yield* Deferred.make<void>();
        const tasks = [task(0), task(1), task(2)];
        const harness = yield* makeHarness({
          tasks,
          executor: () =>
            Effect.succeed({
              launch: (item) =>
                Effect.succeed({
                  launched: Effect.void,
                  awaitResult: Ref.updateAndGet(
                    active,
                    (value) => value + 1,
                  ).pipe(
                    Effect.tap((value) =>
                      Ref.update(maximum, (current) =>
                        Math.max(current, value),
                      ),
                    ),
                    Effect.tap((value) =>
                      value === 3
                        ? Deferred.succeed(allStarted, undefined)
                        : Effect.void,
                    ),
                    Effect.zipRight(Deferred.await(allStarted)),
                    Effect.zipRight(Effect.yieldNow()),
                    Effect.ensuring(Ref.update(active, (value) => value - 1)),
                    Effect.as(resultFor(item)),
                  ),
                }),
            }),
        });

        const execution = yield* harness.batch.execute(
          requestFor(tasks),
          parent,
          () => Effect.void,
        );
        expect(execution.results.map(({ agent }) => agent)).toEqual([
          "agent-0",
          "agent-1",
          "agent-2",
        ]);
        expect(yield* Ref.get(maximum)).toBe(3);
      }),
  );

  it.effect("returns request order when completion order is 2, 0, 1", () =>
    Effect.gen(function* () {
      const tasks = [task(0), task(1), task(2)];
      const completions = yield* Effect.forEach(tasks, () =>
        Deferred.make<RunResult>(),
      );
      const harness = yield* makeHarness({
        tasks,
        executor: () =>
          Effect.succeed({
            launch: (item) => {
              const completion = completions[item.index];
              return completion === undefined
                ? Effect.die(new Error("Missing completion"))
                : Effect.succeed({
                    launched: Effect.void,
                    awaitResult: Deferred.await(completion),
                  });
            },
          }),
      });
      const fiber = yield* Effect.fork(
        harness.batch.execute(requestFor(tasks), parent, () => Effect.void),
      );
      yield* Effect.yieldNow();
      for (const index of [2, 0, 1]) {
        const completion = completions[index];
        if (completion === undefined)
          return yield* Effect.die("missing deferred");
        yield* Deferred.succeed(
          completion,
          resultFor(tasks[index] ?? task(index)),
        );
      }
      const results = yield* Fiber.join(fiber);
      expect(results.results.map((result) => result.runId)).toEqual([
        "run-0",
        "run-1",
        "run-2",
      ]);
    }),
  );

  it.effect(
    "returns mixed DONE, BLOCKED, and FAILED results after all launch",
    () =>
      Effect.gen(function* () {
        const tasks = [task(0), task(1), task(2)];
        const statuses = ["DONE", "BLOCKED", "FAILED"] as const;
        const harness = yield* makeHarness({
          tasks,
          executor: () =>
            Effect.succeed({
              launch: (item) =>
                Effect.succeed({
                  launched: Effect.void,
                  awaitResult: Effect.succeed(
                    resultFor(item, statuses[item.index] ?? "FAILED"),
                  ),
                }),
            }),
        });
        const results = yield* harness.batch.execute(
          requestFor(tasks),
          parent,
          () => Effect.void,
        );
        expect(results.results.map((result) => result.status)).toEqual(
          statuses,
        );
      }),
  );

  it.effect("serializes concurrent progress publication monotonically", () =>
    Effect.gen(function* () {
      const tasks = [task(0), task(1)];
      const firstPublicationEntered = yield* Deferred.make<void>();
      const secondPublicationAttempted = yield* Deferred.make<void>();
      const secondPublicationEntered = yield* Deferred.make<void>();
      const releaseFirstPublication = yield* Deferred.make<void>();
      const observed: Array<ReadonlyArray<string>> = [];
      const progressFor = (
        item: ResolvedTask,
        run: ActiveRunStore,
      ): ChildProgress => ({
        runId: run.artifacts.runId,
        agent: item.agent.name,
        lifecycle: "RUNNING",
        items: [],
        usage: {
          input: item.index,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
        },
      });
      const harness = yield* makeHarness({
        tasks,
        executor: () =>
          Effect.succeed({
            launch: (item, run, onProgress) =>
              Effect.succeed({
                launched: (item.index === 0
                  ? onProgress(progressFor(item, run))
                  : Deferred.await(firstPublicationEntered).pipe(
                      Effect.zipRight(
                        Deferred.succeed(secondPublicationAttempted, undefined),
                      ),
                      Effect.zipRight(onProgress(progressFor(item, run))),
                    )
                ).pipe(Effect.ignore),
                awaitResult: Effect.succeed(resultFor(item)),
              }),
          }),
      });
      const execution = yield* Effect.fork(
        harness.batch.execute(requestFor(tasks), parent, (progress) =>
          Effect.sync(() => {
            observed.push(progress.children.map((child) => child.lifecycle));
            return observed.length;
          }).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.succeed(firstPublicationEntered, undefined).pipe(
                    Effect.zipRight(Deferred.await(releaseFirstPublication)),
                  )
                : Deferred.succeed(secondPublicationEntered, undefined),
            ),
          ),
        ),
      );
      yield* Deferred.await(secondPublicationAttempted);
      yield* Effect.forEach(
        Array.from({ length: 100 }),
        () => Effect.yieldNow(),
        {
          discard: true,
        },
      );
      const overtookFirst = yield* Deferred.isDone(secondPublicationEntered);
      yield* Deferred.succeed(releaseFirstPublication, undefined);
      yield* Fiber.join(execution);
      expect(overtookFirst).toBe(false);
      expect(observed).toEqual([
        ["RUNNING", "STARTING"],
        ["RUNNING", "RUNNING"],
      ]);
    }),
  );

  it.effect("deeply isolates aggregate progress from callback mutation", () =>
    Effect.gen(function* () {
      const tasks = [task(0), task(1)];
      const firstDelivered = yield* Deferred.make<void>();
      const finalSnapshots: Array<import("./batch").BatchProgress> = [];
      const harness = yield* makeHarness({
        tasks,
        executor: () =>
          Effect.succeed({
            launch: (item, run, onProgress) => {
              const snapshot: ChildProgress = {
                runId: run.artifacts.runId,
                agent: item.agent.name,
                lifecycle: "RUNNING",
                items: [
                  {
                    type: "assistant",
                    text: `original-${item.index}`,
                  },
                ],
                usage: {
                  input: item.index + 1,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  turns: 0,
                },
              };
              return Effect.succeed({
                launched: (item.index === 0
                  ? onProgress(snapshot)
                  : Deferred.await(firstDelivered).pipe(
                      Effect.zipRight(onProgress(snapshot)),
                    )
                ).pipe(Effect.ignore),
                awaitResult: Effect.succeed(resultFor(item)),
              });
            },
          }),
      });
      yield* harness.batch.execute(requestFor(tasks), parent, (progress) =>
        Effect.sync(() => {
          finalSnapshots.push(progress);
          const first = progress.children[0];
          if (first !== undefined && finalSnapshots.length === 1) {
            Reflect.set(first.usage, "input", 999);
            const firstItem = first.items[0];
            if (firstItem !== undefined) {
              Reflect.set(firstItem, "text", "mutated");
            }
          }
          return finalSnapshots.length;
        }).pipe(
          Effect.flatMap((count) =>
            count === 1
              ? Deferred.succeed(firstDelivered, undefined)
              : Effect.void,
          ),
        ),
      );
      const final = finalSnapshots.at(-1);
      const first = final?.children[0];
      const firstItem = first?.items[0];
      expect(first?.usage.input).toBe(1);
      expect(firstItem).toEqual({ type: "assistant", text: "original-0" });
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first?.items)).toBe(true);
      expect(Object.isFrozen(firstItem)).toBe(true);
      expect(Object.isFrozen(first?.usage)).toBe(true);
    }),
  );

  it.effect("publishes ordered aggregate progress snapshots", () =>
    Effect.gen(function* () {
      const tasks = [task(0), task(1)];
      const seen: Array<ReadonlyArray<string>> = [];
      const harness = yield* makeHarness({
        tasks,
        executor: () =>
          Effect.succeed({
            launch: (item, run, onProgress) => {
              const snapshot: ChildProgress = {
                runId: run.artifacts.runId,
                agent: item.agent.name,
                lifecycle: "RUNNING",
                items: [],
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  turns: 0,
                },
              };
              return Effect.succeed({
                launched: onProgress(snapshot).pipe(Effect.ignore),
                awaitResult: Effect.succeed(resultFor(item)),
              });
            },
          }),
      });
      yield* harness.batch.execute(requestFor(tasks), parent, (progress) =>
        Effect.sync(() => {
          seen.push(progress.children.map((child) => child.runId));
        }),
      );
      expect(seen.at(-1)).toEqual(["run-0", "run-1"]);
    }),
  );
});

describe("SubagentBatch atomic barriers and rollback", () => {
  it.effect(
    "rolls back an executor child that exits successfully before a delayed sibling launch fails",
    () =>
      Effect.gen(function* () {
        const tasks = [task(0), task(1)];
        const events: Array<string> = [];
        const runs = yield* Effect.forEach(tasks, ({ index }) =>
          makeFakeRun(index, events),
        );
        const executor = yield* RunExecutor;
        const process = yield* ProcessServiceTest;
        const store: RunStore = {
          create: ({ index }) => {
            const run = runs[index];
            return run === undefined
              ? Effect.die(new Error(`missing run ${index}`))
              : Effect.succeed(run.store);
          },
        };
        const batch = makeSubagentBatch({
          discover: Effect.succeed(emptyDiscovery),
          preflight: () => Effect.succeed(tasks),
          store,
          executor,
        });
        const execution = yield* Effect.fork(
          batch.execute(requestFor(tasks), parent, () => Effect.void),
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* process.getState).processes.length === 2) break;
          yield* Effect.yieldNow();
        }

        yield* process.emitLaunch(0);
        for (const event of batchCompletionEvents()) {
          yield* process.emitStdout(0, JSON.stringify(event));
        }
        yield* process.complete(0, { code: 0, signal: null });
        for (let attempt = 0; attempt < 20; attempt += 1) {
          yield* Effect.yieldNow();
        }

        const first = runs[0];
        if (first === undefined) return yield* Effect.die("missing first run");
        expect((yield* first.status).status).toBe("RUNNING");
        yield* process.emitLaunchFailure(
          1,
          new ProcessError({ operation: "spawn", message: "delayed failure" }),
        );
        expect(Either.isLeft(yield* Effect.either(Fiber.join(execution)))).toBe(
          true,
        );
        expect(
          yield* Effect.forEach(runs, (run) => run.status).pipe(
            Effect.map((statuses) => statuses.map(({ status }) => status)),
          ),
        ).toEqual(["FAILED", "FAILED"]);
      }).pipe(Effect.provide(batchExecutorLayer)),
  );

  it.effect(
    "strict decode and preflight failures create and launch nothing",
    () =>
      Effect.gen(function* () {
        const decodeHarness = yield* makeHarness({ tasks: [task(0)] });
        const decodeExit = yield* Effect.exit(
          decodeHarness.batch.execute(
            { tasks: [{ agent: "agent-0", task: "work", extra: true }] },
            parent,
            () => Effect.void,
          ),
        );
        expect(Exit.isFailure(decodeExit)).toBe(true);
        expect(yield* decodeHarness.createCalls).toBe(0);
        expect(yield* decodeHarness.launchCalls).toBe(0);

        const preflightHarness = yield* makeHarness({
          tasks: [task(0)],
          preflightFailure: new InvalidSubagentInput({
            subject: "agent-0",
            field: "agent",
            message: "missing agent",
          }),
        });
        const preflight = yield* Effect.either(
          preflightHarness.batch.execute(
            requestFor([task(0)]),
            parent,
            () => Effect.void,
          ),
        );
        expect(Either.isLeft(preflight)).toBe(true);
        expect(yield* preflightHarness.createCalls).toBe(0);
        expect(yield* preflightHarness.launchCalls).toBe(0);
      }),
  );

  it.effect("rolls back a created run when later artifact creation fails", () =>
    Effect.gen(function* () {
      const tasks = [task(0), task(1), task(2)];
      const harness = yield* makeHarness({ tasks, createFailureAt: 1 });
      const outcome = yield* Effect.either(
        harness.batch.execute(requestFor(tasks), parent, () => Effect.void),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      expect(yield* harness.createCalls).toBe(2);
      expect(yield* harness.launchCalls).toBe(0);
      const first = harness.runs[0];
      if (first === undefined) return yield* Effect.die("missing run");
      expect((yield* first.status).status).toBe("FAILED");
      expect((yield* first.status).diagnostics).toContain(
        INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
      );
    }),
  );

  it.effect(
    "sanitizes rollback summaries while retaining raw control-bearing diagnostics",
    () =>
      Effect.gen(function* () {
        const controls =
          "\u001b[31mCSI\u001b[0m BEL\u0007 C1\u0085 " +
          "\u001b_APC-PAYLOAD\u001b\\ " +
          "\u001b]52;c;T1NDLTUyLUNMSVBCT0FSRA==\u0007";
        const tasks = [task(0), task(1), task(2)];
        const harness = yield* makeHarness({
          tasks,
          createFailureAt: 2,
          createFailureMessage: `partial setup failed ${controls}`,
        });

        expect(
          Either.isLeft(
            yield* Effect.either(
              harness.batch.execute(
                requestFor(tasks),
                parent,
                () => Effect.void,
              ),
            ),
          ),
        ).toBe(true);

        for (const run of harness.runs.slice(0, 2)) {
          const status = yield* run.status;
          expect(status.status).toBe("FAILED");
          expect(status.summary).toBeDefined();
          expect(status.summary).toBe(
            sanitizeTerminalText(status.summary ?? ""),
          );
          expect(status.diagnostics?.join(" ")).toContain(controls);
          expect(() => decodeRunStatusRecord(status)).not.toThrow();
        }
      }),
  );

  it.effect("records FAILED before interrupting launch scope", () =>
    Effect.gen(function* () {
      const tasks = [task(0), task(1), task(2)];
      const firstLaunched = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        tasks,
        executor: (_runs, events) =>
          Effect.succeed({
            launch: (item) =>
              Effect.addFinalizer(() =>
                Effect.sync(() => {
                  events.push(`interrupt-${item.index}`);
                }),
              ).pipe(
                Effect.as<RunHandle>({
                  launched:
                    item.index === 0
                      ? Deferred.succeed(firstLaunched, undefined).pipe(
                          Effect.tap(() =>
                            Effect.sync(() => events.push("launched-0")),
                          ),
                          Effect.asVoid,
                        )
                      : item.index === 1
                        ? Deferred.await(firstLaunched).pipe(
                            Effect.zipRight(
                              Effect.fail(
                                new ChildProcessError({
                                  operation: "launch",
                                  agent: item.agent.name,
                                  runId: `run-${item.index}`,
                                  message: "launch rejected",
                                }),
                              ),
                            ),
                          )
                        : Effect.never,
                  awaitResult: Effect.never,
                }),
              ),
          }),
      });
      const outcome = yield* Effect.either(
        harness.batch.execute(requestFor(tasks), parent, () => Effect.void),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      const lastFailed = Math.max(
        ...harness.events
          .map((event, index) => (event.startsWith("FAILED-") ? index : -1))
          .filter((index) => index >= 0),
      );
      const firstInterrupt = harness.events.findIndex((event) =>
        event.startsWith("interrupt-"),
      );
      expect(lastFailed).toBeGreaterThanOrEqual(0);
      expect(firstInterrupt).toBeGreaterThan(lastFailed);
      for (const run of harness.runs) {
        expect((yield* run.status).status).toBe("FAILED");
      }
    }),
  );

  it.effect(
    "preserves rollback status-write diagnostics in the parent failure",
    () =>
      Effect.gen(function* () {
        const tasks = [task(0), task(1)];
        const harness = yield* makeHarness({
          tasks,
          createFailureAt: 1,
          rollbackFailureAt: 0,
          rollbackFailureMessage: "disk rejected rollback status",
        });
        const outcome = yield* Effect.either(
          harness.batch.execute(requestFor(tasks), parent, () => Effect.void),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isRight(outcome)) return;
        expect(outcome.left.message).toContain("create-1 failed");
        expect(outcome.left.message).toContain("disk rejected rollback status");
      }),
  );
});

describe("SubagentBatch post-barrier independence and cancellation", () => {
  it.effect(
    "aggregates multiple await failures by request index after every await finishes",
    () =>
      Effect.gen(function* () {
        const tasks = [task(0), task(1), task(2)];
        const finished = yield* Ref.make<ReadonlyArray<number>>([]);
        const failures: ReadonlyArray<SubagentError> = [
          new ChildProcessError({
            operation: "wait",
            runId: "run-0",
            agent: "agent-0",
            message: "primary wait failed",
          }),
          new RunStoreError({
            operation: "readStatus",
            path: "/runs/run-1/status.json",
            runId: "run-1",
            message: "secondary status failed",
          }),
          new ChildProcessError({
            operation: "wait",
            runId: "run-2",
            agent: "agent-2",
            message: "tertiary wait failed",
          }),
        ];
        const harness = yield* makeHarness({
          tasks,
          executor: () =>
            Effect.succeed({
              launch: (item) => {
                const failure = failures[item.index];
                return failure === undefined
                  ? Effect.die("missing failure")
                  : Effect.succeed({
                      launched: Effect.void,
                      awaitResult: Effect.yieldNow().pipe(
                        Effect.zipRight(
                          Ref.update(finished, (indices) => [
                            ...indices,
                            item.index,
                          ]),
                        ),
                        Effect.zipRight(Effect.fail(failure)),
                      ),
                    });
              },
            }),
        });
        const outcome = yield* Effect.either(
          harness.batch.execute(requestFor(tasks), parent, () => Effect.void),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isRight(outcome)) return;
        expect(outcome.left).toBeInstanceOf(ChildProcessError);
        expect(outcome.left._tag).toBe("ChildProcessError");
        if (outcome.left._tag !== "ChildProcessError") return;
        expect(outcome.left.runId).toBe("run-0");
        expect(outcome.left.agent).toBe("agent-0");
        expect(outcome.left.operation).toBe("wait");
        expect(outcome.left.message).toContain("primary wait failed");
        expect(outcome.left.message).toContain(
          "child[1] RunStoreError (run-1): secondary status failed",
        );
        expect(outcome.left.message).toContain(
          "child[2] ChildProcessError (run-2): tertiary wait failed",
        );
        expect([...(yield* Ref.get(finished))].sort()).toEqual([0, 1, 2]);
      }),
  );

  it.effect("waits for siblings independently after one await failure", () =>
    Effect.gen(function* () {
      const tasks = [task(0), task(1), task(2)];
      const siblingCompleted = yield* Ref.make(false);
      const harness = yield* makeHarness({
        tasks,
        executor: () =>
          Effect.succeed({
            launch: (item) =>
              Effect.succeed({
                launched: Effect.void,
                awaitResult:
                  item.index === 0
                    ? Effect.fail(
                        new ChildProcessError({
                          operation: "wait",
                          runId: "run-0",
                          agent: item.agent.name,
                          message: "wait failed",
                        }),
                      )
                    : item.index === 1
                      ? Effect.yieldNow().pipe(
                          Effect.zipRight(Ref.set(siblingCompleted, true)),
                          Effect.as(resultFor(item)),
                        )
                      : Effect.succeed(resultFor(item)),
              }),
          }),
      });
      const outcome = yield* Effect.either(
        harness.batch.execute(requestFor(tasks), parent, () => Effect.void),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      expect(yield* Ref.get(siblingCompleted)).toBe(true);
      expect(harness.events.some((event) => event.startsWith("FAILED-"))).toBe(
        false,
      );
    }),
  );

  it.effect(
    "cancellation at a sequential create boundary tracks completed runs",
    () =>
      Effect.gen(function* () {
        const tasks = [task(0), task(1)];
        const secondCreateStarted = yield* Deferred.make<void>();
        const allowSecondCreateReturn = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          tasks,
          create: (item, run) =>
            item.index === 0
              ? Effect.succeed(run)
              : Deferred.succeed(secondCreateStarted, undefined).pipe(
                  Effect.zipRight(Deferred.await(allowSecondCreateReturn)),
                  Effect.as(run),
                ),
        });
        const execution = yield* Effect.fork(
          harness.batch.execute(requestFor(tasks), parent, () => Effect.void),
        );
        yield* Deferred.await(secondCreateStarted);
        const interruption = yield* Effect.fork(Fiber.interrupt(execution));
        yield* Effect.yieldNow();
        yield* Deferred.succeed(allowSecondCreateReturn, undefined);
        yield* Fiber.join(interruption);
        for (const run of harness.runs) {
          expect((yield* run.status).status).toBe("ABORTED");
        }
      }),
  );

  it.effect(
    "defers interruption after durable status creation until the run is tracked",
    () =>
      Effect.gen(function* () {
        const tasks = [task(0)];
        const statusCreated = yield* Deferred.make<void>();
        const allowCreateReturn = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          tasks,
          create: (_item, run) =>
            Deferred.succeed(statusCreated, undefined).pipe(
              Effect.zipRight(Deferred.await(allowCreateReturn)),
              Effect.as(run),
            ),
        });
        const execution = yield* Effect.fork(
          harness.batch.execute(requestFor(tasks), parent, () => Effect.void),
        );
        yield* Deferred.await(statusCreated);
        const interruption = yield* Effect.fork(Fiber.interrupt(execution));
        yield* Effect.yieldNow();
        yield* Deferred.succeed(allowCreateReturn, undefined);
        yield* Fiber.join(interruption);
        const first = harness.runs[0];
        if (first === undefined) return yield* Effect.die("missing first run");
        expect((yield* first.status).status).toBe("ABORTED");
        expect(
          (yield* first.transitions).map((record) => record.status),
        ).toContain("ABORTED");
      }),
  );

  it.effect(
    "parent cancellation records ABORTED for every nonterminal run",
    () =>
      Effect.gen(function* () {
        const tasks = [task(0), task(1), task(2)];
        const launched = yield* Deferred.make<void>();
        const launchCount = yield* Ref.make(0);
        const harness = yield* makeHarness({
          tasks,
          executor: (runs) =>
            Effect.succeed({
              launch: (item) => {
                const run = runs[item.index];
                if (run === undefined) return Effect.die("missing run");
                return Effect.addFinalizer(() =>
                  run.store
                    .transition({
                      status: "ABORTED",
                      updatedAt: "2026-07-12T00:00:01.000Z",
                      summary: "Parent cancelled subagent run",
                    })
                    .pipe(Effect.ignore),
                ).pipe(
                  Effect.zipRight(
                    Ref.updateAndGet(launchCount, (count) => count + 1),
                  ),
                  Effect.tap((count) =>
                    count === tasks.length
                      ? Deferred.succeed(launched, undefined)
                      : Effect.void,
                  ),
                  Effect.as<RunHandle>({
                    launched: Effect.void,
                    awaitResult: Effect.never,
                  }),
                );
              },
            }),
        });
        const fiber = yield* Effect.fork(
          harness.batch.execute(requestFor(tasks), parent, () => Effect.void),
        );
        yield* Deferred.await(launched);
        yield* Fiber.interrupt(fiber);
        for (const run of harness.runs) {
          expect((yield* run.status).status).toBe("ABORTED");
        }
        expect(Option.isSome(yield* Fiber.poll(fiber))).toBe(true);
      }),
  );
});
