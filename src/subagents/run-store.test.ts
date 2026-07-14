import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Either, Layer, TestClock } from "effect";
import { expect } from "vitest";
import { EnvironmentServiceTest } from "../../test/services/environment";
import { FileSystemServiceTest } from "../../test/services/file-system";
import { HomeDirectoryServiceTest } from "../../test/services/home-directory";
import { FileSystemError, FileSystemService } from "../services/file-system";
import type { ResolvedTask } from "./preflight";
import {
  INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
  RunIdFactory,
  RunStore,
  type RunStore as RunStoreShape,
} from "./run-store";
import { decodeRunManifestJson, decodeRunStatusRecordJson } from "./schemas";

const createdAt = "2026-07-12T10:11:12.345Z";
const createdAtMillis = Date.parse(createdAt);

const resolvedTask = (task = "Inspect the secret contract."): ResolvedTask =>
  Object.freeze({
    index: 1,
    task,
    cwd: "/repo",
    agent: Object.freeze({
      name: "alpha",
      description: "Handle delegated work",
      rolePrompt: "Act as a careful delegated agent.",
      model: "openai-codex/gpt-5.4",
      thinking: "high",
      tools: Object.freeze(["read", "grep"]),
      providerExtensions: Object.freeze(["/extensions/search.ts"]),
      definitionPath: "/agents/alpha.md",
    }),
  });

const idFactory = (...ids: ReadonlyArray<string>): RunIdFactory => {
  let index = 0;
  return {
    generate: Effect.sync(() => {
      const id = ids[index] ?? `generated-${index}`;
      index += 1;
      return id;
    }),
  };
};

const serviceLayer = (agentDirectory: string, ids: ReadonlyArray<string>) => {
  const infrastructure = Layer.mergeAll(
    FileSystemService.Live,
    EnvironmentServiceTest.layer({
      values: { PI_CODING_AGENT_DIR: agentDirectory },
    }),
    HomeDirectoryServiceTest.layer({ homeDirectory: "/unused-home" }),
  );
  return Layer.merge(
    infrastructure,
    RunStore.layer(idFactory(...ids)).pipe(Layer.provide(infrastructure)),
  );
};

const fakeServiceLayer = (
  ids: ReadonlyArray<string>,
  fileSystemLayer: ReturnType<typeof FileSystemServiceTest.layer>,
) => {
  const infrastructure = Layer.mergeAll(
    fileSystemLayer,
    EnvironmentServiceTest.layer({
      values: { PI_CODING_AGENT_DIR: "/agent" },
    }),
    HomeDirectoryServiceTest.layer({ homeDirectory: "/unused-home" }),
  );
  return Layer.merge(
    infrastructure,
    RunStore.layer(idFactory(...ids)).pipe(Layer.provide(infrastructure)),
  );
};

const withTemporaryDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      mkdtemp(path.join(tmpdir(), "pi-subagent-runs-")).then((directory) =>
        realpath(directory, "utf8"),
      ),
    ),
    use,
    (directory) =>
      Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );

const expectRejected = (result: Either.Either<boolean, unknown>): void => {
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toMatchObject({ _tag: "RunStoreError" });
  }
};

const createStore = Effect.gen(function* () {
  const store = yield* RunStore;
  return yield* store.create(resolvedTask());
});

describe("RunStore", () => {
  it.effect(
    "creates the exact private artifact set with frozen execution data",
    () =>
      withTemporaryDirectory((agentDirectory) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(createdAtMillis);
          const store = yield* RunStore;
          const task = resolvedTask();
          const run = yield* store.create(task);
          const runId = `${createdAtMillis}-run-uuid`;
          const runDirectory = path.join(
            agentDirectory,
            "subagents",
            "runs",
            runId,
          );

          expect(run.artifacts).toEqual({
            runId,
            runDirectory,
            manifestPath: path.join(runDirectory, "run.json"),
            taskPath: path.join(runDirectory, "task.md"),
            systemPromptPath: path.join(runDirectory, "system-prompt.md"),
            eventsPath: path.join(runDirectory, "events.jsonl"),
            stderrPath: path.join(runDirectory, "stderr.log"),
            statusPath: path.join(runDirectory, "status.json"),
          });
          expect(Object.isFrozen(run.artifacts)).toBe(true);

          const fileSystem = yield* FileSystemService;
          expect((yield* fileSystem.stat(runDirectory)).mode & 0o777).toBe(
            0o700,
          );
          const entries = yield* fileSystem.readDirectory(runDirectory);
          expect(entries.map(({ name }) => name).sort()).toEqual([
            "events.jsonl",
            "run.json",
            "status.json",
            "stderr.log",
            "system-prompt.md",
            "task.md",
          ]);
          for (const entry of entries) {
            expect(entry.kind).toBe("file");
            expect(
              (yield* fileSystem.stat(path.join(runDirectory, entry.name)))
                .mode & 0o777,
            ).toBe(0o600);
          }

          const manifestRaw = yield* fileSystem.readTextFile(
            run.artifacts.manifestPath,
          );
          expect(manifestRaw.endsWith("\n")).toBe(true);
          const persistedManifest = decodeRunManifestJson(manifestRaw);
          expect(persistedManifest).toEqual({
            runId,
            createdAt,
            task: { index: 1, cwd: "/repo" },
            agent: {
              name: "alpha",
              description: "Handle delegated work",
              model: "openai-codex/gpt-5.4",
              thinking: "high",
              tools: ["read", "grep"],
              providerExtensions: ["/extensions/search.ts"],
              definitionPath: "/agents/alpha.md",
            },
            artifacts: run.artifacts,
          });
          expect(persistedManifest.agent).toEqual({
            name: "alpha",
            description: "Handle delegated work",
            model: "openai-codex/gpt-5.4",
            thinking: "high",
            tools: ["read", "grep"],
            providerExtensions: ["/extensions/search.ts"],
            definitionPath: "/agents/alpha.md",
          });
          expect(persistedManifest.agent).not.toHaveProperty("writer");
          expect(Object.isFrozen(persistedManifest)).toBe(true);

          expect(yield* fileSystem.readTextFile(run.artifacts.taskPath)).toBe(
            task.task,
          );
          expect(yield* fileSystem.readTextFile(run.artifacts.systemPromptPath))
            .toBe(`Act as a careful delegated agent.

Do not launch subagents or delegate this task. Complete it yourself.

Before finishing, call complete_subagent exactly once as your sole final tool call. Use status DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED; provide a concise single-line summary; and provide an absolute reportPath when a report is required.
`);
          expect(yield* fileSystem.readTextFile(run.artifacts.eventsPath)).toBe(
            "",
          );
          expect(yield* fileSystem.readTextFile(run.artifacts.stderrPath)).toBe(
            "",
          );

          const initialStatusRaw = yield* fileSystem.readTextFile(
            run.artifacts.statusPath,
          );
          expect(initialStatusRaw.endsWith("\n")).toBe(true);
          expect(decodeRunStatusRecordJson(initialStatusRaw)).toEqual({
            status: "STARTING",
            updatedAt: createdAt,
          });

          for (const artifactPath of [
            run.artifacts.manifestPath,
            run.artifacts.systemPromptPath,
            run.artifacts.eventsPath,
            run.artifacts.stderrPath,
            run.artifacts.statusPath,
          ]) {
            expect(yield* fileSystem.readTextFile(artifactPath)).not.toContain(
              task.task,
            );
          }

          yield* run.appendEvent('{"type":"message"}\n');
          yield* run.appendStderr("warning\npartial");
          expect(yield* fileSystem.readTextFile(run.artifacts.eventsPath)).toBe(
            '{"type":"message"}\n',
          );
          expect(yield* fileSystem.readTextFile(run.artifacts.stderrPath)).toBe(
            "warning\npartial",
          );
        }).pipe(Effect.provide(serviceLayer(agentDirectory, ["run-uuid"]))),
      ),
  );

  it.effect(
    "commits STARTING to RUNNING to terminal and ignores late terminal writes",
    () =>
      withTemporaryDirectory((agentDirectory) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(createdAtMillis);
          const run = yield* createStore;
          expect(
            yield* run.transition({
              status: "RUNNING",
              updatedAt: "2026-07-12T10:11:13.345Z",
            }),
          ).toBe(true);
          expect(
            yield* run.transition({
              status: "DONE",
              updatedAt: "2026-07-12T10:11:14.345Z",
              summary: "complete",
            }),
          ).toBe(true);
          expect(
            yield* run.transition({
              status: "FAILED",
              updatedAt: "2026-07-12T10:11:15.345Z",
              summary: "late",
            }),
          ).toBe(false);
          expect(yield* run.readStatus).toEqual({
            status: "DONE",
            updatedAt: "2026-07-12T10:11:14.345Z",
            summary: "complete",
          });
        }).pipe(
          Effect.provide(
            serviceLayer(agentDirectory, [
              "run-uuid",
              "running-temp",
              "done-temp",
            ]),
          ),
        ),
      ),
  );

  it.effect("serializes competing terminal commits so exactly one wins", () =>
    withTemporaryDirectory((agentDirectory) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(createdAtMillis);
        const run = yield* createStore;
        yield* run.transition({ status: "RUNNING", updatedAt: createdAt });
        const outcomes = yield* Effect.all(
          [
            run.transition({
              status: "DONE",
              updatedAt: "2026-07-12T10:11:13.345Z",
              summary: "finished",
            }),
            run.transition({
              status: "ABORTED",
              updatedAt: "2026-07-12T10:11:13.346Z",
              summary: "cancelled",
            }),
          ],
          { concurrency: 2 },
        );

        expect(outcomes.filter(Boolean)).toHaveLength(1);
        expect(outcomes.filter((outcome) => !outcome)).toHaveLength(1);
        expect(["DONE", "ABORTED"]).toContain((yield* run.readStatus).status);
      }).pipe(
        Effect.provide(
          serviceLayer(agentDirectory, [
            "run-uuid",
            "running-temp",
            "terminal-one",
            "terminal-two",
          ]),
        ),
      ),
    ),
  );

  it.effect(
    "rejects non-monotonic transitions while permitting cancellation and marked infrastructure rollback",
    () =>
      withTemporaryDirectory((agentDirectory) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(createdAtMillis);
          const store = yield* RunStore;

          const directSemantic = yield* store.create(resolvedTask("semantic"));
          expectRejected(
            yield* Effect.either(
              directSemantic.transition({
                status: "DONE",
                updatedAt: createdAt,
                summary: "too early",
              }),
            ),
          );

          const directAborted = yield* store.create(resolvedTask("aborted"));
          expect(
            yield* directAborted.transition({
              status: "ABORTED",
              updatedAt: createdAt,
              summary: "parent cancelled before launch acknowledgement",
            }),
          ).toBe(true);
          expect((yield* directAborted.readStatus).status).toBe("ABORTED");

          const unmarkedFailure = yield* store.create(resolvedTask("failed"));
          expectRejected(
            yield* Effect.either(
              unmarkedFailure.transition({
                status: "FAILED",
                updatedAt: createdAt,
                diagnostics: ["setup failed"],
              }),
            ),
          );

          const rollback = yield* store.create(resolvedTask("rollback"));
          expect(
            yield* rollback.transition({
              status: "FAILED",
              updatedAt: createdAt,
              summary: "batch setup failed",
              diagnostics: [
                "launch acknowledgement failed",
                INFRASTRUCTURE_ROLLBACK_DIAGNOSTIC,
              ],
            }),
          ).toBe(true);

          const running = yield* store.create(resolvedTask("running"));
          yield* running.transition({
            status: "RUNNING",
            updatedAt: createdAt,
          });
          expectRejected(
            yield* Effect.either(
              running.transition({ status: "STARTING", updatedAt: createdAt }),
            ),
          );
          expectRejected(
            yield* Effect.either(
              running.transition({ status: "RUNNING", updatedAt: createdAt }),
            ),
          );
          expect((yield* running.readStatus).status).toBe("RUNNING");
        }).pipe(
          Effect.provide(
            serviceLayer(agentDirectory, [
              "semantic-run",
              "aborted-run",
              "failed-run",
              "rollback-run",
              "rollback-temp",
              "running-run",
              "running-temp",
            ]),
          ),
        ),
      ),
  );

  it.effect(
    "atomically replaces status through a private temporary file",
    () => {
      const layer = fakeServiceLayer(
        ["run-uuid", "status-temp-uuid"],
        FileSystemServiceTest.layer(),
      );
      return Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const run = yield* createStore;
        const files = yield* FileSystemServiceTest;
        yield* files.resetCalls;

        expect(
          yield* run.transition({
            status: "RUNNING",
            updatedAt: "1970-01-01T00:00:00.000Z",
          }),
        ).toBe(true);

        const temporaryPath = path.join(
          run.artifacts.runDirectory,
          "status.status-temp-uuid.tmp",
        );
        const calls = (yield* files.getState).calls;
        expect(calls).toEqual([
          { operation: "readTextFile", path: run.artifacts.statusPath },
          {
            operation: "writeTextFile",
            path: temporaryPath,
            content:
              '{\n  "status": "RUNNING",\n  "updatedAt": "1970-01-01T00:00:00.000Z"\n}\n',
            mode: 0o600,
          },
          {
            operation: "rename",
            path: `${temporaryPath} -> ${run.artifacts.statusPath}`,
            from: temporaryPath,
            to: run.artifacts.statusPath,
          },
        ]);
        expect((yield* files.getState).contents.has(temporaryPath)).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "removes a leftover temp on rename failure without replacing the primary error",
    () => {
      const layer = fakeServiceLayer(
        ["run-uuid", "status-temp-uuid"],
        FileSystemServiceTest.layer(),
      );
      return Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const run = yield* createStore;
        const files = yield* FileSystemServiceTest;
        const temporaryPath = path.join(
          run.artifacts.runDirectory,
          "status.status-temp-uuid.tmp",
        );
        const renamePath = `${temporaryPath} -> ${run.artifacts.statusPath}`;
        yield* files.setFailure(
          "rename",
          renamePath,
          new FileSystemError({
            operation: "rename",
            path: renamePath,
            message: "primary rename failure",
          }),
        );
        yield* files.setFailure(
          "remove",
          temporaryPath,
          new FileSystemError({
            operation: "remove",
            path: temporaryPath,
            message: "secondary cleanup failure",
          }),
        );
        yield* files.resetCalls;

        const result = yield* Effect.either(
          run.transition({
            status: "RUNNING",
            updatedAt: "1970-01-01T00:00:00.000Z",
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toMatchObject({
            _tag: "RunStoreError",
            operation: "rename",
            path: renamePath,
            message: "primary rename failure",
            runId: `${0}-run-uuid`,
          });
        }
        expect((yield* files.getState).calls.at(-1)).toEqual({
          operation: "remove",
          path: temporaryPath,
          recursive: undefined,
        });
        expect((yield* run.readStatus).status).toBe("STARTING");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "retains partial creation evidence and reports the failing path",
    () => {
      const runDirectory = "/agent/subagents/runs/0-run-uuid";
      const systemPromptPath = path.join(runDirectory, "system-prompt.md");
      const failure = new FileSystemError({
        operation: "writeTextFile",
        path: systemPromptPath,
        message: "disk full",
      });
      const layer = fakeServiceLayer(
        ["run-uuid"],
        FileSystemServiceTest.layer({
          failures: new Map([
            ["writeTextFile", new Map([[systemPromptPath, failure]])],
          ]),
        }),
      );

      return Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const store: RunStoreShape = yield* RunStore;
        const result = yield* Effect.either(store.create(resolvedTask()));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toMatchObject({
            _tag: "RunStoreError",
            operation: "writeTextFile",
            path: systemPromptPath,
            message: "disk full",
            runId: "0-run-uuid",
          });
        }

        const state = yield* (yield* FileSystemServiceTest).getState;
        expect(state.metadata.get(runDirectory)).toMatchObject({
          kind: "directory",
          mode: 0o700,
        });
        expect(state.contents.get(path.join(runDirectory, "task.md"))).toBe(
          resolvedTask().task,
        );
        expect(
          state.calls.some(
            (call) => call.operation === "remove" && call.path === runDirectory,
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
});
