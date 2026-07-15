import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";
import { Effect, Either, Fiber, Layer, TestServices } from "effect";
import { expect } from "vitest";
import {
  EnvironmentService,
  type EnvironmentService as Environment,
} from "../services/environment";
import {
  FileSystemService,
  type FileSystemService as FileSystem,
} from "../services/file-system";
import { HomeDirectoryService } from "../services/home-directory";
import {
  ProcessService,
  type ProcessShutdownPolicy,
} from "../services/process";
import { SubagentBatch } from "./batch";
import type { ModelResolutionPort, ParentSnapshot } from "./preflight";
import { RunExecutor, type RunExecutorConfig } from "./run-executor";
import { RunStore } from "./run-store";
import {
  decodeRunManifestJson,
  decodeRunStatusRecordJson,
  type RunManifest,
  type RunStatus,
  type RunStatusRecord,
} from "./schemas";

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/fake-pi.ts", import.meta.url),
);
const inheritedToolProviderPath = fileURLToPath(
  new URL("../../test/fixtures/inherited-tool-provider.ts", import.meta.url),
);

interface ExecutableSelection {
  readonly command: string;
  readonly prefix: ReadonlyArray<string>;
}

type ExecutableSelector = () => ExecutableSelection;

const fakeExecutableSelector: ExecutableSelector = () => ({
  command: process.execPath,
  prefix: [fixturePath],
});

const inheritedEnvironment = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const withPrivateSandbox = <A, E, R>(
  use: (sandbox: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      mkdtemp(path.join(tmpdir(), "pi-subagents-integration-")).then(
        async (directory) => {
          await chmod(directory, 0o700);
          return directory;
        },
      ),
    ),
    use,
    (sandbox) =>
      Effect.promise(() => rm(sandbox, { recursive: true, force: true })),
  );

const environmentLayer = (sandbox: string) => {
  const snapshot: Readonly<Record<string, string>> = Object.freeze({
    ...inheritedEnvironment(),
    PI_CODING_AGENT_DIR: sandbox,
  });
  const service: Environment = {
    get: (name) => Effect.succeed(snapshot[name]),
    snapshot: Effect.succeed(snapshot),
  };
  return Layer.succeed(EnvironmentService, service);
};

const noCredentialModels: ModelResolutionPort = {
  resolve: (pattern, thinking) => Effect.succeed({ model: pattern, thinking }),
};

const parent = (cwd: string): ParentSnapshot => ({
  cwd,
  model: "fake-provider/fake-model",
  thinking: "off",
  activeToolNames: ["read", "bash", "edit", "write"],
  toolProviders: ["read", "bash", "edit", "write"].map((name) => ({
    name,
    source: "builtin",
    path: `<builtin:${name}>`,
  })),
});

const integrationLayer = (
  sandbox: string,
  executableSelector: ExecutableSelector = fakeExecutableSelector,
  shutdownPolicy?: ProcessShutdownPolicy,
  postExitDrainTimeout?: RunExecutorConfig["postExitDrainTimeout"],
) => {
  const environment = environmentLayer(sandbox);
  const home = Layer.succeed(HomeDirectoryService, {
    get: Effect.succeed(sandbox),
  });
  const infrastructure = Layer.mergeAll(
    FileSystemService.Live,
    ProcessService.Live,
    environment,
    home,
  );
  const store = RunStore.Live.pipe(Layer.provide(infrastructure));
  const executor = RunExecutor.layer({
    completionEntrypoint: fixturePath,
    executableSelector,
    ...(shutdownPolicy === undefined ? {} : { shutdownPolicy }),
    ...(postExitDrainTimeout === undefined ? {} : { postExitDrainTimeout }),
  }).pipe(Layer.provide(infrastructure));
  const batchDependencies = Layer.mergeAll(infrastructure, store, executor);
  const batch = SubagentBatch.layer(noCredentialModels).pipe(
    Layer.provide(batchDependencies),
  );
  return Layer.merge(infrastructure, batch);
};

const writeDefinitions = (sandbox: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const directory = path.join(sandbox, "subagents", "agents");
    yield* fileSystem.makeDirectory(directory, {
      recursive: true,
      mode: 0o700,
    });
    yield* fileSystem.makeDirectory(path.join(sandbox, "observations"), {
      recursive: true,
      mode: 0o700,
    });
    const definitions = [
      { name: "alpha", description: "Integration alpha" },
      { name: "beta", description: "Integration beta" },
      { name: "gamma", description: "Integration gamma" },
    ] as const;
    yield* Effect.forEach(
      definitions,
      ({ name, description }) =>
        fileSystem.writeTextFile(
          path.join(directory, `${name}.md`),
          `---\nname: ${name}\ndescription: ${description}\n---\nHandle the delegated task and report the result.\n`,
          { mode: 0o600 },
        ),
      { discard: true },
    );
  });

interface PersistedRun {
  readonly manifest: RunManifest;
  readonly status: RunStatusRecord;
}

const readPersistedRuns = (
  fileSystem: FileSystem,
  sandbox: string,
): Effect.Effect<ReadonlyArray<PersistedRun>> => {
  const runsDirectory = path.join(sandbox, "subagents", "runs");
  return fileSystem.readDirectory(runsDirectory).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries.filter((entry) => entry.kind === "directory"),
        (entry) => {
          const directory = path.join(runsDirectory, entry.name);
          return Effect.all({
            manifest: fileSystem
              .readTextFile(path.join(directory, "run.json"))
              .pipe(Effect.map(decodeRunManifestJson)),
            status: fileSystem
              .readTextFile(path.join(directory, "status.json"))
              .pipe(Effect.map(decodeRunStatusRecordJson)),
          });
        },
      ),
    ),
    Effect.catchAll(() => Effect.succeed([])),
    Effect.map((runs) =>
      [...runs].sort(
        (left, right) => left.manifest.task.index - right.manifest.task.index,
      ),
    ),
  );
};

const waitForRuns = (
  fileSystem: FileSystem,
  sandbox: string,
  count: number,
  statuses?: ReadonlySet<RunStatus>,
): Effect.Effect<ReadonlyArray<PersistedRun>> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const runs = yield* readPersistedRuns(fileSystem, sandbox);
      if (
        runs.length === count &&
        (statuses === undefined ||
          runs.every((run) => statuses.has(run.status.status)))
      ) {
        return runs;
      }
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
      );
    }
    return yield* Effect.die(
      new Error(`Timed out waiting for ${count} persisted runs`),
    );
  });

type JsonObject = Readonly<Record<string, unknown>>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonLines = (raw: string): ReadonlyArray<unknown> =>
  raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

const observationPath = (sandbox: string, id: string): string =>
  path.join(sandbox, "observations", `${id}.jsonl`);

const parseObservations = (raw: string): ReadonlyArray<JsonObject> =>
  parseJsonLines(raw).flatMap((value) => (isJsonObject(value) ? [value] : []));

const observationFor = (
  observations: ReadonlyArray<JsonObject>,
  event: string,
): JsonObject | undefined =>
  observations.find((observation) => observation.event === event);

const readObservations = (
  fileSystem: FileSystem,
  sandbox: string,
  id: string,
): Effect.Effect<ReadonlyArray<JsonObject>> =>
  fileSystem.readTextFile(observationPath(sandbox, id)).pipe(
    Effect.map(parseObservations),
    Effect.catchAll(() => Effect.succeed([])),
  );

const waitForObservation = (
  fileSystem: FileSystem,
  sandbox: string,
  id: string,
  event: string,
): Effect.Effect<ReadonlyArray<JsonObject>> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const observations = yield* readObservations(fileSystem, sandbox, id);
      if (observationFor(observations, event) !== undefined) {
        return observations;
      }
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
      );
    }
    return yield* Effect.die(
      new Error(`Timed out waiting for ${id} observation ${event}`),
    );
  });

const waitForProcessExitSync = (sandbox: string, id: string): void => {
  const sidecarPath = observationPath(sandbox, id);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const observations = parseObservations(readFileSync(sidecarPath, "utf8"));
      if (observationFor(observations, "exit") !== undefined) return;
    } catch {
      // The child creates the sidecar only after its signal handler is installed.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  throw new Error(`Timed out waiting for ${id} process exit`);
};

const observationNumber = (
  observation: JsonObject | undefined,
  field: string,
): number | undefined => {
  const value = observation?.[field];
  return typeof value === "number" ? value : undefined;
};

const observationString = (
  observation: JsonObject | undefined,
  field: string,
): string | undefined => {
  const value = observation?.[field];
  return typeof value === "string" ? value : undefined;
};

const assertCommonOverlap = (
  observationSets: ReadonlyArray<ReadonlyArray<JsonObject>>,
): void => {
  const starts = observationSets.flatMap((observations) => {
    const at = observationNumber(observationFor(observations, "ready"), "at");
    return at === undefined ? [] : [at];
  });
  const ends = observationSets.flatMap((observations) => {
    const at = observationNumber(observationFor(observations, "end"), "at");
    return at === undefined ? [] : [at];
  });
  expect(starts).toHaveLength(observationSets.length);
  expect(ends).toHaveLength(observationSets.length);
  expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
};

const eventObject = (
  events: ReadonlyArray<unknown>,
  index: number,
): JsonObject | undefined => {
  const value = events[index];
  return isJsonObject(value) ? value : undefined;
};

const messageObject = (
  event: JsonObject | undefined,
): JsonObject | undefined =>
  isJsonObject(event?.message) ? event.message : undefined;

const assertStrictCompletionProtocol = (
  raw: string,
  id: string,
  taskPath: string,
  taskText: string,
  status: "DONE" | "BLOCKED",
  summary: string,
): void => {
  const events = parseJsonLines(raw);
  expect(
    events.map((event) =>
      isJsonObject(event) && typeof event.type === "string"
        ? event.type
        : "invalid",
    ),
  ).toEqual([
    "session",
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "message_start",
    "message_end",
    "turn_end",
    "agent_end",
    "agent_settled",
  ]);

  const callId = `complete-${id}`;
  const session = eventObject(events, 0);
  expect(typeof session?.timestamp).toBe("string");
  expect(typeof session?.cwd).toBe("string");
  expect(session).toEqual({
    type: "session",
    version: 3,
    id: `fake-session-${id}`,
    timestamp: session?.timestamp,
    cwd: session?.cwd,
  });
  expect(eventObject(events, 1)).toEqual({ type: "agent_start" });
  expect(eventObject(events, 2)).toEqual({ type: "turn_start" });

  const userStart = messageObject(eventObject(events, 3));
  const userEnd = messageObject(eventObject(events, 4));
  const expandedTaskPrompt = `<file name="${taskPath}">\n${taskText}\n</file>\n`;
  expect(userStart?.content).not.toBe(taskText);
  expect(userStart).toEqual({
    role: "user",
    content: expandedTaskPrompt,
    timestamp: userStart?.timestamp,
  });
  expect(userEnd).toEqual(userStart);
  expect(eventObject(events, 3)).toEqual({
    type: "message_start",
    message: userStart,
  });
  expect(eventObject(events, 4)).toEqual({
    type: "message_end",
    message: userEnd,
  });

  const assistantStart = messageObject(eventObject(events, 5));
  const assistantUpdateEvent = eventObject(events, 6);
  const assistantUpdate = messageObject(assistantUpdateEvent);
  const assistantEnd = messageObject(eventObject(events, 7));
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const usage = {
    input: 11,
    output: 7,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 23,
    cost: {
      input: 0.11,
      output: 0.07,
      cacheRead: 0.03,
      cacheWrite: 0.02,
      total: 0.23,
    },
  };
  const toolCall = {
    type: "toolCall",
    id: callId,
    name: "complete_subagent",
    arguments: { status, summary },
  };
  expect(assistantStart).toEqual({
    role: "assistant",
    content: [],
    api: "fake-pi-json",
    provider: "fake-provider",
    model: "fake-model",
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp: assistantStart?.timestamp,
  });
  expect(assistantEnd).toEqual({
    role: "assistant",
    content: [toolCall],
    api: "fake-pi-json",
    provider: "fake-provider",
    model: "fake-model",
    usage,
    stopReason: "toolUse",
    timestamp: assistantStart?.timestamp,
  });
  expect(assistantUpdate).toEqual(assistantEnd);
  expect(eventObject(events, 5)).toEqual({
    type: "message_start",
    message: assistantStart,
  });
  const assistantMessageEvent = {
    type: "toolcall_end",
    contentIndex: 0,
    toolCall,
    partial: assistantEnd,
  };
  expect(assistantUpdateEvent).toEqual({
    type: "message_update",
    message: assistantUpdate,
    assistantMessageEvent,
  });
  expect(eventObject(events, 7)).toEqual({
    type: "message_end",
    message: assistantEnd,
  });

  expect(eventObject(events, 8)).toEqual({
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: "complete_subagent",
    args: { status, summary },
  });
  const completionResult = {
    content: [
      { type: "text", text: `Subagent completion recorded: ${status}` },
    ],
    details: { status, summary },
    terminate: true,
  };
  expect(eventObject(events, 9)).toEqual({
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: "complete_subagent",
    result: completionResult,
    isError: false,
  });

  const toolResultStart = messageObject(eventObject(events, 10));
  const toolResultEnd = messageObject(eventObject(events, 11));
  expect(toolResultStart).toEqual({
    role: "toolResult",
    toolCallId: callId,
    toolName: "complete_subagent",
    content: completionResult.content,
    details: completionResult.details,
    isError: false,
    timestamp: toolResultStart?.timestamp,
  });
  expect(toolResultEnd).toEqual(toolResultStart);
  expect(eventObject(events, 10)).toEqual({
    type: "message_start",
    message: toolResultStart,
  });
  expect(eventObject(events, 11)).toEqual({
    type: "message_end",
    message: toolResultEnd,
  });
  expect(eventObject(events, 12)).toEqual({
    type: "turn_end",
    message: assistantEnd,
    toolResults: [toolResultEnd],
  });
  expect(eventObject(events, 13)).toEqual({
    type: "agent_end",
    messages: [userEnd, assistantEnd, toolResultEnd],
    willRetry: false,
  });
  expect(eventObject(events, 14)).toEqual({ type: "agent_settled" });
};

const runTest = <A, E>(
  use: (sandbox: string) => Effect.Effect<A, E, SubagentBatch | FileSystem>,
  options?: {
    readonly executableSelector?: (sandbox: string) => ExecutableSelector;
    readonly shutdownPolicy?: ProcessShutdownPolicy;
    readonly postExitDrainTimeout?: RunExecutorConfig["postExitDrainTimeout"];
  },
) =>
  TestServices.provideLive(
    withPrivateSandbox((sandbox) =>
      writeDefinitions(sandbox).pipe(
        Effect.zipRight(use(sandbox)),
        Effect.provide(
          integrationLayer(
            sandbox,
            options?.executableSelector?.(sandbox),
            options?.shutdownPolicy,
            options?.postExitDrainTimeout,
          ),
        ),
      ),
    ),
  );

const execute = (request: unknown, sandbox: string) =>
  Effect.gen(function* () {
    const batch = yield* SubagentBatch;
    const execution = yield* batch.execute(
      request,
      parent(sandbox),
      () => Effect.void,
    );
    return execution.results;
  });

type AgentName = "alpha" | "beta" | "gamma";

const task = (agent: AgentName, mode: string, id: string, delay = 80) => ({
  agent,
  task: `${mode}\n${id}\ndelay=${delay}\n`,
});

const FAST_GRACEFUL_TIMEOUT_MS = 100;
const FAST_TOTAL_TIMEOUT_MS = 260;
const CLEANUP_SCHEDULER_TOLERANCE_MS = 1_000;

const fastShutdown: ProcessShutdownPolicy = {
  stdinCloseTimeout: 20,
  gracefulTimeout: FAST_GRACEFUL_TIMEOUT_MS,
  forcedTimeout: 100,
  totalTimeout: FAST_TOTAL_TIMEOUT_MS,
};

describe("subagents credential-free real-process integration", () => {
  it.effect(
    "runs builtin general with an exact safe allowlist despite unsafe active names",
    () =>
      runTest((sandbox) =>
        Effect.gen(function* () {
          const batch = yield* SubagentBatch;
          const fileSystem = yield* FileSystemService;
          const execution = yield* batch.execute(
            {
              tasks: [
                {
                  task: "success\ninherited-general\ndelay=20\n",
                },
              ],
            },
            {
              cwd: sandbox,
              model: "fake-provider/fake-model",
              thinking: "off",
              activeToolNames: [
                "read",
                "inherited_probe",
                "subagent,inherited_probe",
                " subagent ",
                "sdk_bound",
                "subagent",
                "complete_subagent",
              ],
              toolProviders: [
                {
                  name: "read",
                  source: "builtin",
                  path: "<builtin:read>",
                },
                {
                  name: "inherited_probe",
                  source: "local",
                  path: inheritedToolProviderPath,
                },
                {
                  name: "subagent,inherited_probe",
                  source: "local",
                  path: inheritedToolProviderPath,
                },
                {
                  name: " subagent ",
                  source: "local",
                  path: inheritedToolProviderPath,
                },
                {
                  name: "sdk_bound",
                  source: "sdk",
                  path: "<sdk:sdk_bound>",
                },
              ],
            },
            () => Effect.void,
          );

          expect(execution.results).toHaveLength(1);
          expect(execution.results[0]).toMatchObject({
            agent: "general",
            status: "DONE",
            summary: "Fake Pi completed inherited-general",
          });
          expect(execution.diagnostics).toHaveLength(3);
          expect(execution.diagnostics.join(" ")).toContain(
            "subagent,inherited_probe",
          );
          expect(execution.diagnostics.join(" ")).toContain("sdk_bound");

          const result = execution.results[0];
          if (result === undefined) return;
          const manifest = decodeRunManifestJson(
            yield* fileSystem.readTextFile(result.artifacts.manifestPath),
          );
          expect(manifest.agent).toMatchObject({
            name: "general",
            source: "builtin",
          });
          expect(manifest.agent).not.toHaveProperty("definitionPath");
          expect(manifest.toolInheritance).toEqual({
            parentActiveToolNames: [
              "read",
              "inherited_probe",
              "subagent,inherited_probe",
              " subagent ",
              "sdk_bound",
              "subagent",
              "complete_subagent",
            ],
            effectiveToolNames: [
              "read",
              "inherited_probe",
              "complete_subagent",
            ],
            providerExtensions: [inheritedToolProviderPath],
            diagnostics: [
              expect.stringContaining("subagent,inherited_probe"),
              expect.stringContaining("subagent"),
              expect.stringContaining("sdk_bound"),
            ],
          });

          const observations = yield* waitForObservation(
            fileSystem,
            sandbox,
            "inherited-general",
            "validation",
          );
          expect(observationFor(observations, "validation")).toMatchObject({
            toolNames: "read,inherited_probe,complete_subagent",
            extensionPaths: `${fixturePath},${inheritedToolProviderPath}`,
            completionToolCount: 1,
            subagentActive: false,
            normalExtensionsDisabled: true,
          });
        }),
      ),
  );

  it.effect(
    "runs one successful child with strict completion and private artifacts",
    () =>
      runTest((sandbox) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const [result] = yield* execute(
            { tasks: [task("alpha", "success", "single")] },
            sandbox,
          );
          expect(result).toBeDefined();
          if (result === undefined) return;
          expect(result).toMatchObject({
            agent: "alpha",
            status: "DONE",
            summary: "Fake Pi completed single",
            exitCode: 0,
            signal: null,
            usage: {
              input: 11,
              output: 7,
              cacheRead: 3,
              cacheWrite: 2,
              cost: 0.23,
              turns: 1,
            },
          });
          expect(
            (yield* fileSystem.stat(result.artifacts.runDirectory)).mode &
              0o777,
          ).toBe(0o700);
          for (const artifactPath of [
            result.artifacts.manifestPath,
            result.artifacts.taskPath,
            result.artifacts.systemPromptPath,
            result.artifacts.eventsPath,
            result.artifacts.stderrPath,
            result.artifacts.statusPath,
          ]) {
            expect((yield* fileSystem.stat(artifactPath)).mode & 0o777).toBe(
              0o600,
            );
          }
          const stderr = yield* fileSystem.readTextFile(
            result.artifacts.stderrPath,
          );
          expect(stderr).toContain("validation=passed");
          const manifest = decodeRunManifestJson(
            yield* fileSystem.readTextFile(result.artifacts.manifestPath),
          );
          expect(manifest.agent).not.toHaveProperty("writer");
          const observations = yield* waitForObservation(
            fileSystem,
            sandbox,
            "single",
            "end",
          );
          const validation = observationFor(observations, "validation");
          expect(validation).toMatchObject({
            event: "validation",
            id: "single",
            mode: "success",
            taskPath: result.artifacts.taskPath,
            systemPromptPath: result.artifacts.systemPromptPath,
            taskReferenceCount: 1,
            promptOptionCount: 1,
            taskAbsolute: true,
            promptAbsolute: true,
            sameRunDirectory: true,
            promptValidated: true,
            directTaskBody: false,
            directPromptBody: false,
          });
          expect(typeof validation?.identity).toBe("string");
          expect(typeof validation?.pid).toBe("number");
        }),
      ),
  );

  it.effect("overlaps three unrestricted agents in real child processes", () =>
    runTest((sandbox) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const results = yield* execute(
          {
            tasks: [
              task("alpha", "success", "parallel-0", 240),
              task("beta", "success", "parallel-1", 240),
              task("gamma", "success", "parallel-2", 240),
            ],
          },
          sandbox,
        );
        expect(results.map(({ agent }) => agent)).toEqual([
          "alpha",
          "beta",
          "gamma",
        ]);
        expect(results.map(({ status }) => status)).toEqual([
          "DONE",
          "DONE",
          "DONE",
        ]);
        const observationSets = yield* Effect.forEach(
          ["parallel-0", "parallel-1", "parallel-2"],
          (id) => waitForObservation(fileSystem, sandbox, id, "end"),
        );
        assertCommonOverlap(observationSets);
      }),
    ),
  );

  it.effect("preserves ordered mixed semantic outcomes", () =>
    runTest((sandbox) =>
      execute(
        {
          tasks: [
            task("alpha", "success", "mixed-done"),
            task("alpha", "blocked", "mixed-blocked"),
            task("alpha", "malformed", "mixed-malformed"),
          ],
        },
        sandbox,
      ).pipe(
        Effect.tap((results) =>
          Effect.sync(() => {
            expect(results.map((result) => result.status)).toEqual([
              "DONE",
              "BLOCKED",
              "FAILED",
            ]);
            expect(results[1]?.summary).toBe("Fake Pi blocked mixed-blocked");
            expect(results[2]?.diagnostics.join(" ")).toContain("malformed");
          }),
        ),
      ),
    ),
  );

  it.effect(
    "records nonzero exits and missing completion as independent failures",
    () =>
      runTest((sandbox) =>
        execute(
          {
            tasks: [
              task("alpha", "nonzero", "exit-23"),
              task("alpha", "missing-completion", "no-completion"),
            ],
          },
          sandbox,
        ).pipe(
          Effect.tap((results) =>
            Effect.sync(() => {
              expect(results.map((result) => result.status)).toEqual([
                "FAILED",
                "FAILED",
              ]);
              expect(results[0]?.exitCode).toBe(23);
              expect(results[0]?.diagnostics.join(" ")).toContain("code 23");
              expect(results[1]?.exitCode).toBe(0);
              expect(results[1]?.diagnostics.join(" ")).toContain(
                "no valid structured completion",
              );
            }),
          ),
        ),
      ),
  );

  it.effect(
    "rolls back every run when child zero exits before delayed child one launch fails",
    () => {
      let launchFailureSelectedAt: number | undefined;
      return runTest(
        (sandbox) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystemService;
            const outcome = yield* Effect.either(
              execute(
                {
                  tasks: [
                    task("alpha", "success", "launched-first", 0),
                    task("alpha", "success", "launch-fails"),
                  ],
                },
                sandbox,
              ),
            );
            const cleanupElapsed =
              Date.now() - (launchFailureSelectedAt ?? Date.now());
            expect(launchFailureSelectedAt).toBeDefined();
            expect(Either.isLeft(outcome)).toBe(true);
            expect(cleanupElapsed).toBeLessThanOrEqual(
              FAST_TOTAL_TIMEOUT_MS + CLEANUP_SCHEDULER_TOLERANCE_MS,
            );
            const runs = yield* waitForRuns(
              fileSystem,
              sandbox,
              2,
              new Set(["FAILED"]),
            );
            expect(runs.map((run) => run.status.status)).toEqual([
              "FAILED",
              "FAILED",
            ]);
            const observations = yield* waitForObservation(
              fileSystem,
              sandbox,
              "launched-first",
              "end",
            );
            const ready = observationFor(observations, "ready");
            const end = observationFor(observations, "end");
            expect(end).toMatchObject({
              event: "end",
              id: "launched-first",
              mode: "success",
            });
            expect(observationString(end, "identity")).toBe(
              observationString(ready, "identity"),
            );
            const pid = observationNumber(end, "pid");
            expect(pid).toBeDefined();
            expect(pid === undefined ? true : processIsAlive(pid)).toBe(false);
          }),
        {
          executableSelector: (sandbox) => {
            let selections = 0;
            return () => {
              selections += 1;
              if (selections === 1) return fakeExecutableSelector();
              waitForProcessExitSync(sandbox, "launched-first");
              launchFailureSelectedAt = Date.now();
              return {
                command: path.join(tmpdir(), "missing-fake-pi"),
                prefix: [],
              };
            };
          },
          shutdownPolicy: fastShutdown,
        },
      );
    },
  );

  it.effect(
    "cancels to ABORTED and escalates an ignored SIGTERM to SIGKILL",
    () =>
      runTest(
        (sandbox) =>
          Effect.gen(function* () {
            const batch = yield* SubagentBatch;
            const fileSystem = yield* FileSystemService;
            const fiber = yield* Effect.fork(
              batch.execute(
                {
                  tasks: [
                    task("alpha", "launch-delay", "term-exits", 5_000),
                    task("alpha", "stall", "term-stalls", 0),
                  ],
                },
                parent(sandbox),
                () => Effect.void,
              ),
            );
            yield* waitForRuns(fileSystem, sandbox, 2, new Set(["RUNNING"]));
            yield* Effect.all([
              waitForObservation(fileSystem, sandbox, "term-exits", "ready"),
              waitForObservation(fileSystem, sandbox, "term-stalls", "ready"),
            ]);
            const cleanupStartedAt = Date.now();
            yield* Fiber.interrupt(fiber);
            const cleanupElapsed = Date.now() - cleanupStartedAt;
            expect(cleanupElapsed).toBeGreaterThanOrEqual(
              FAST_GRACEFUL_TIMEOUT_MS - 20,
            );
            expect(cleanupElapsed).toBeLessThanOrEqual(
              FAST_TOTAL_TIMEOUT_MS + CLEANUP_SCHEDULER_TOLERANCE_MS,
            );
            const runs = yield* waitForRuns(
              fileSystem,
              sandbox,
              2,
              new Set(["ABORTED"]),
            );
            expect(runs.map((run) => run.status.status)).toEqual([
              "ABORTED",
              "ABORTED",
            ]);
            const gracefulObservations = yield* waitForObservation(
              fileSystem,
              sandbox,
              "term-exits",
              "sigterm",
            );
            const forcedObservations = yield* waitForObservation(
              fileSystem,
              sandbox,
              "term-stalls",
              "sigterm",
            );
            const gracefulReady = observationFor(gracefulObservations, "ready");
            const forcedReady = observationFor(forcedObservations, "ready");
            const graceful = observationFor(gracefulObservations, "sigterm");
            const forced = observationFor(forcedObservations, "sigterm");
            expect(graceful).toMatchObject({
              status: "ABORTED",
              action: "exit",
            });
            expect(forced).toMatchObject({
              status: "ABORTED",
              action: "stall",
            });
            expect(observationString(graceful, "identity")).toBe(
              observationString(gracefulReady, "identity"),
            );
            expect(observationString(forced, "identity")).toBe(
              observationString(forcedReady, "identity"),
            );
            const gracefulPid = observationNumber(graceful, "pid");
            const forcedPid = observationNumber(forced, "pid");
            expect(gracefulPid).toBeDefined();
            expect(forcedPid).toBeDefined();
            expect(
              gracefulPid === undefined ? true : processIsAlive(gracefulPid),
            ).toBe(false);
            expect(
              forcedPid === undefined ? true : processIsAlive(forcedPid),
            ).toBe(false);
          }),
        { shutdownPolicy: fastShutdown },
      ),
  );

  it.effect(
    "fails promptly when a descendant retains inherited output descriptors",
    () =>
      runTest(
        (sandbox) =>
          Effect.gen(function* () {
            const startedAt = Date.now();
            const [result] = yield* execute(
              { tasks: [task("alpha", "retained-output", "retained-fds", 0)] },
              sandbox,
            );
            expect(result).toBeDefined();
            if (result === undefined) return;
            expect(result.status).toBe("FAILED");
            expect(result.exitCode).toBe(0);
            expect(result.diagnostics).toContain(
              "Process output did not drain after exit; retained evidence may be truncated",
            );
            expect(Date.now() - startedAt).toBeLessThan(1_500);
          }),
        { postExitDrainTimeout: 100 },
      ),
  );

  it.effect("retains real stdout JSONL and stderr markers in artifacts", () =>
    runTest((sandbox) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const results = yield* execute(
          { tasks: [task("alpha", "success", "stream-artifacts")] },
          sandbox,
        );
        const result = results[0];
        expect(result).toBeDefined();
        if (result === undefined) return;
        const events = yield* fileSystem.readTextFile(
          result.artifacts.eventsPath,
        );
        const stderr = yield* fileSystem.readTextFile(
          result.artifacts.stderrPath,
        );
        assertStrictCompletionProtocol(
          events,
          "stream-artifacts",
          result.artifacts.taskPath,
          "success\nstream-artifacts\ndelay=80",
          "DONE",
          "Fake Pi completed stream-artifacts",
        );
        expect(stderr).toContain("FAKE_PI ready");
        expect(stderr).toContain("FAKE_PI start");
        expect(stderr).toContain("FAKE_PI end");
        expect(stderr).toContain("validation=passed");
      }),
    ),
  );
});
