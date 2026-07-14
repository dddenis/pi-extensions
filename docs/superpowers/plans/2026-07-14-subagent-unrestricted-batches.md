# Unrestricted Subagent Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove subagent mutation classification so every valid one-to-three-task request passes the same preflight and may execute concurrently.

**Architecture:** Keep the existing discovery → preflight → durable run → executor → ordered batch pipeline, but delete `writer` from every definition, resolved-agent, error, and manifest contract. Tool allowlists continue to control child tool availability and external provider loading; the existing batch launch barrier, concurrent execution, rollback, cancellation, progress, and ordered-result behavior remain unchanged.

**Tech Stack:** Bun, TypeScript 6, Effect 3.21, Effect Schema, TypeBox, Pi extension/JSON CLI APIs, Vitest 4, `@effect/vitest`.

## Global Constraints

- Agent frontmatter supports exactly `name`, `description`, `model`, `thinking`, and `tools`; strict decoding rejects `writer` and every other unknown field.
- A request contains one to three tasks, and every accepted task may run concurrently regardless of its declared tools.
- Tool allowlists affect child tool availability and provider-extension loading only; they never affect scheduling eligibility.
- `DiscoveredAgent`, `ResolvedAgent`, and `RunManifestAgent` contain no mutation or writer classification.
- Keep preflight validation for discovery, uniqueness, working directories, model/thinking resolution, reserved tools, provider provenance, and external provider paths.
- Keep the existing launch barrier, rollback, cancellation, progress, result ordering, and terminal-status behavior unchanged.
- Use role-neutral fixture names such as `alpha`, `beta`, and `gamma`; do not encode scheduling semantics in fixture names.
- Prefer the current contract over backward compatibility: persisted or configured objects containing `writer` are invalid rather than migrated.
- Use Bun for commands, Effect patterns for services and orchestration, and Effect Schema for runtime contracts; do not edit `.context/` or add unsafe assertions/non-null assertions.
- Update `docs/specs/subagents.md` and superseded subagent design material in the same change so the repository presents one consistent contract.

---

## File and Responsibility Map

### Domain and orchestration

- Modify `src/subagents/schemas.ts` — remove `writer` from strict frontmatter, resolved manifest types, schemas, and immutable decoders.
- Modify `src/subagents/agents.ts` — stop defaulting or preserving mutation classification in discovered definitions.
- Modify `src/subagents/preflight.ts` — remove reader-safe classification and writer-count scheduling while retaining all resolution and provenance checks.
- Modify `src/subagents/errors.ts` — remove `UnsafeReaderError` and `WriterPolicyError` from the tagged error model and formatter.
- Modify `src/subagents/run-store.ts` — persist only identity, execution settings, tool configuration, provider extensions, and definition path.
- Modify `src/subagents/batch.ts` — remove obsolete policy-error cloning while preserving batch lifecycle behavior.
- Modify `src/subagents/index.ts` — remove obsolete policy errors from the Pi-boundary error guard.

### Contract, orchestration, and integration tests

- Modify `src/subagents/schemas.test.ts` — prove `writer` is rejected and manifests without it are valid.
- Modify `src/subagents/agents.test.ts` — prove discovery outputs no classification and diagnoses legacy `writer` frontmatter.
- Modify `src/subagents/preflight.test.ts` — replace reader/writer policy tests with unrestricted tool-policy and retained provenance tests.
- Modify `src/subagents/run-store.test.ts` — prove persisted manifests contain no classification.
- Modify `src/subagents/batch.test.ts` — prove three role-neutral tasks with mutation-capable tool sets overlap and remain ordered.
- Modify `src/subagents/child-command.test.ts` — update `ResolvedTask` fixtures to the new contract and role-neutral names.
- Modify `src/subagents/run-executor.test.ts` — update `ResolvedTask` fixtures to the new contract and role-neutral names.
- Modify `src/subagents/index.test.ts` — replace role-coded adapter fixtures with role-neutral names without changing boundary behavior.
- Modify `src/subagents/subagents.integration.test.ts` — use role-neutral definitions and prove real child processes overlap regardless of tool capability.
- Modify `src/subagents/progress.test.ts` — replace classification-coded fixture names without changing progress assertions.
- Modify `src/subagents/render.test.ts` — replace classification-coded fixture names without changing rendering assertions.

### Documentation

- Modify `docs/specs/subagents.md` — make uniform one-to-three-task concurrency the living contract.
- Modify `docs/superpowers/specs/2026-07-12-lightweight-subagent-execution-engine-design.md` — revise the milestone-one design to remove superseded mutation policy.
- Modify `docs/superpowers/specs/2026-07-10-lightweight-subagent-extension-design.md` — remove the old classification and override from the historical source design.
- Modify `docs/superpowers/plans/2026-07-12-lightweight-subagent-execution-engine.md` — revise obsolete implementation guidance and examples so they no longer reintroduce classification.

No new production module, dependency, package entrypoint, request field, or tool parameter is required.

---

### Task 1: Remove Mutation Classification End to End

**Files:**

- Modify: `src/subagents/schemas.ts:167-207,265-333,392-432`
- Modify: `src/subagents/agents.ts:11-16,59-79`
- Modify: `src/subagents/preflight.ts:9-31,34-45,222-244,360-385,392-436`
- Modify: `src/subagents/errors.ts:23-47,82-107`
- Modify: `src/subagents/run-store.ts:178-199`
- Modify: `src/subagents/batch.ts:18-31,160-216`
- Modify: `src/subagents/index.ts:20-34,230-239`
- Test: `src/subagents/schemas.test.ts`
- Test: `src/subagents/agents.test.ts`
- Test: `src/subagents/preflight.test.ts`
- Test: `src/subagents/run-store.test.ts`
- Test: `src/subagents/batch.test.ts`
- Test: `src/subagents/child-command.test.ts`
- Test: `src/subagents/run-executor.test.ts`
- Test: `src/subagents/index.test.ts`
- Test: `src/subagents/subagents.integration.test.ts`
- Test: `src/subagents/progress.test.ts`
- Test: `src/subagents/render.test.ts`

**Interfaces:**

- Consumes: existing `SubagentRequest`, `AgentDiscovery`, `ParentSnapshot`, `ModelResolutionPort`, `RunStore`, and `RunExecutor` contracts.
- Produces:

```ts
export interface AgentFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly tools?: ReadonlyArray<string>;
}

export interface DiscoveredAgent extends AgentFrontmatter {
  readonly rolePrompt: string;
  readonly definitionPath: string;
}

export interface ResolvedAgent {
  readonly name: string;
  readonly description: string;
  readonly rolePrompt: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly tools?: ReadonlyArray<string>;
  readonly providerExtensions: ReadonlyArray<string>;
  readonly definitionPath: string;
}

export interface RunManifestAgent {
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly tools?: ReadonlyArray<string>;
  readonly providerExtensions: ReadonlyArray<string>;
  readonly definitionPath: string;
}
```

- [ ] **Step 1: Add failing strict schema and discovery tests**

In `src/subagents/schemas.test.ts`, remove `writer` from the valid `manifest` fixture and replace the frontmatter assertions with tests that accept only the five supported fields and reject the removed field:

```ts
it("accepts the supported frontmatter and preserves optional absence", () => {
  expect(
    decodeAgentFrontmatter({
      name: " alpha ",
      description: " inspect contracts ",
      model: " provider/model ",
      thinking: "medium",
      tools: " read, grep ",
    }),
  ).toEqual({
    name: "alpha",
    description: "inspect contracts",
    model: "provider/model",
    thinking: "medium",
    tools: ["read", "grep"],
  });

  expect(
    Object.prototype.hasOwnProperty.call(
      decodeAgentFrontmatter({
        name: "beta",
        description: "Inspect only",
      }),
      "tools",
    ),
  ).toBe(false);
});

it("rejects mutation classification as unknown frontmatter", () => {
  expect(() =>
    decodeAgentFrontmatter({
      name: "alpha",
      description: "Inspect contracts",
      writer: false,
    }),
  ).toThrow();
});
```

Also make the persisted contract strict in the existing manifest test:

```ts
it("accepts manifests without mutation classification", () => {
  expect(decodeRunManifest(manifest)).toEqual(manifest);
  expect(decodeRunManifestJson(JSON.stringify(manifest))).toEqual(manifest);
  expect(() =>
    decodeRunManifest({
      ...manifest,
      agent: { ...manifest.agent, writer: false },
    }),
  ).toThrow();
});
```

In `src/subagents/agents.test.ts`, remove the `writer` option from the `definition` helper and add a discovery case containing one supported definition and one legacy definition:

```ts
it.effect(
  "diagnoses removed writer frontmatter without hiding a valid neighbor",
  () => {
    const alphaPath = path.join(definitionsDirectory, "alpha.md");
    const legacyPath = path.join(definitionsDirectory, "legacy.md");
    const testLayer = layer({
      exists: new Map([[definitionsDirectory, true]]),
      directories: new Map([
        [
          definitionsDirectory,
          [alphaPath, legacyPath].map((filePath) => ({
            name: path.basename(filePath),
            kind: "file" as const,
          })),
        ],
      ]),
      contents: new Map([
        [alphaPath, definition("alpha", { tools: "read, grep" })],
        [
          legacyPath,
          "---\nname: legacy\ndescription: Legacy definition\nwriter: false\n---\nHandle the task.",
        ],
      ]),
    });

    return Effect.gen(function* () {
      const result = yield* discoverAgents;
      expect(result.definitions.map(({ name }) => name)).toEqual(["alpha"]);
      expect(result.definitions[0]).not.toHaveProperty("writer");
      expect(result.diagnostics).toEqual([
        {
          definitionPath: legacyPath,
          agentName: "legacy",
          message: expect.stringContaining("writer"),
        },
      ]);
    }).pipe(Effect.provide(testLayer));
  },
);
```

- [ ] **Step 2: Run the schema and discovery tests to verify RED**

Run:

```bash
bun --bun vitest run src/subagents/schemas.test.ts src/subagents/agents.test.ts --reporter dot
```

Expected: FAIL because `writer` is still accepted, defaulted into discovered definitions, and required by run manifests.

- [ ] **Step 3: Add failing unrestricted preflight and batch tests**

In `src/subagents/preflight.test.ts`, remove `UnsafeReaderError`, `WriterPolicyError`, and `READER_SAFE_TOOLS` imports. Change `discoveredAgent` so it has no `writer` option or property, then replace the reader/writer policy suite with this contract test:

```ts
describe("preflight uniform tool policy", () => {
  it.effect(
    "resolves one to three tasks regardless of mutation-capable tools",
    () => {
      const definitions = [
        discoveredAgent("alpha"),
        discoveredAgent("beta", { tools: ["bash"] }),
        discoveredAgent("gamma", { tools: ["read", "edit", "write"] }),
      ];
      return Effect.gen(function* () {
        const result = yield* run({
          definitions,
          parent: parent({
            tools: ["read", "bash", "edit", "write"].map(builtin),
          }),
        });
        expect(result.map(({ agent }) => agent.name)).toEqual([
          "alpha",
          "beta",
          "gamma",
        ]);
        expect(result.map(({ agent }) => agent.tools)).toEqual([
          undefined,
          ["bash"],
          ["read", "edit", "write"],
        ]);
        expect(result.every(({ agent }) => !("writer" in agent))).toBe(true);
      });
    },
  );
});
```

Keep all tool-provider tests, but rename their fixture agents to `alpha`, `beta`, or `gamma`; their expected `ToolProviderError` behavior must not change.

In `src/subagents/batch.test.ts`, use a role-neutral task factory and replace both classification-based concurrency tests with one unrestricted overlap test:

```ts
const task = (
  index: number,
  tools: ReadonlyArray<string> | undefined = ["read"],
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
    ...(tools === undefined ? {} : { tools }),
    providerExtensions: [],
    definitionPath: `/agents/agent-${index}.md`,
  },
});

it.effect(
  "runs three unrestricted tasks concurrently with observed overlap",
  () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const maximum = yield* Ref.make(0);
      const allStarted = yield* Deferred.make<void>();
      const tasks = [task(0, ["bash"]), task(1, ["edit"]), task(2, ["write"])];
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
                    Ref.update(maximum, (current) => Math.max(current, value)),
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
```

- [ ] **Step 4: Run the preflight and batch tests to verify RED**

Run:

```bash
bun --bun vitest run src/subagents/preflight.test.ts src/subagents/batch.test.ts --reporter dot
```

Expected: FAIL because preflight still returns `writer`, rejects multiple mutation-capable agents, and the `ResolvedAgent` fixtures still require classification.

- [ ] **Step 5: Remove classification from schemas and discovery**

In `src/subagents/schemas.ts`:

1. Remove `writer` from `AgentFrontmatter` and `RunManifestAgent`.
2. Remove `writer` from `AgentFrontmatterSchema` and `RunManifestAgentSchema`.
3. Remove both `writer` branches from `freezeAgentFrontmatter` and `freezeRunManifestAgent`.

The final strict schemas are:

```ts
export const AgentFrontmatterSchema = Schema.Struct({
  name: NonEmptyTrimmedSingleLineStringSchema,
  description: NonEmptyTrimmedSingleLineStringSchema,
  model: Schema.optional(NonEmptyTrimmedSingleLineStringSchema),
  thinking: Schema.optional(ThinkingLevelSchema),
  tools: Schema.optional(ToolListSchema),
});

const RunManifestAgentSchema: Schema.Schema<RunManifestAgent> = Schema.Struct({
  name: NonEmptyTrimmedSingleLineStringSchema,
  description: NonEmptyTrimmedSingleLineStringSchema,
  model: NonEmptyTrimmedSingleLineStringSchema,
  thinking: ThinkingLevelSchema,
  tools: Schema.optional(Schema.Array(NonEmptyTrimmedSingleLineStringSchema)),
  providerExtensions: Schema.Array(AbsolutePathSchema),
  definitionPath: AbsolutePathSchema,
});
```

The final immutable manifest-agent copier is:

```ts
const freezeRunManifestAgent = (value: RunManifestAgent): RunManifestAgent =>
  Object.freeze({
    name: value.name,
    description: value.description,
    model: value.model,
    thinking: value.thinking,
    ...(value.tools === undefined ? {} : { tools: stringArray(value.tools) }),
    providerExtensions: stringArray(value.providerExtensions),
    definitionPath: value.definitionPath,
  });
```

In `src/subagents/agents.ts`, make `DiscoveredAgent` add only `rolePrompt` and `definitionPath`, and make `freezeDefinition` return:

```ts
Object.freeze({
  name: frontmatter.name,
  description: frontmatter.description,
  ...(frontmatter.model === undefined ? {} : { model: frontmatter.model }),
  ...(frontmatter.thinking === undefined
    ? {}
    : { thinking: frontmatter.thinking }),
  ...(frontmatter.tools === undefined
    ? {}
    : { tools: Object.freeze([...frontmatter.tools]) }),
  rolePrompt,
  definitionPath,
});
```

Do not add a compatibility decoder for old `writer` frontmatter or old manifests: strict excess-property rejection is the intended contract.

- [ ] **Step 6: Remove policy errors and scheduling gates from preflight**

In `src/subagents/errors.ts`, delete the `UnsafeReaderError` and `WriterPolicyError` classes, remove them from `SubagentError`, and remove their `primarySubject` branches. The final union is:

```ts
export type SubagentError =
  | InvalidSubagentInput
  | AgentDefinitionError
  | ToolProviderError
  | InvalidWorkingDirectoryError
  | RunStoreError
  | ChildProcessError
  | PiEventStreamError
  | CompletionValidationError;
```

In `src/subagents/preflight.ts`:

1. Delete `READER_SAFE_TOOLS`.
2. Delete `validateReader` and its call from `resolveTask`.
3. Remove `writer` from `ResolvedAgent` and `freezeResolvedAgent`.
4. Remove the final writer-count check.
5. Leave `RESERVED_TOOLS`, `resolveWorkingDirectory`, `findDefinition`, `resolveModel`, and `resolveProviderExtensions` behavior unchanged.

The final preflight orchestration is:

```ts
const resolveTask = (
  task: SubagentTaskRequest,
  index: number,
  input: PreflightInput,
): Effect.Effect<ResolvedTask, SubagentError, FileSystemService> =>
  Effect.gen(function* () {
    const definition = yield* findDefinition(task.agent, input.discovery);
    const cwd = yield* resolveWorkingDirectory(task.cwd, input.parent.cwd);
    const resolvedModel = yield* resolveModel(
      definition,
      input.parent,
      input.models,
    );
    const providerExtensions = yield* resolveProviderExtensions(
      definition,
      input.parent,
    );
    return Object.freeze({
      index,
      task: task.task,
      cwd,
      agent: freezeResolvedAgent(
        definition,
        resolvedModel.model,
        resolvedModel.thinking,
        providerExtensions,
      ),
    });
  });

export const preflight = (
  input: PreflightInput,
): Effect.Effect<
  ReadonlyArray<ResolvedTask>,
  SubagentError,
  FileSystemService
> =>
  Effect.forEach(input.request.tasks, (task, index) =>
    resolveTask(task, index, input),
  ).pipe(Effect.map((resolved) => Object.freeze(resolved)));
```

This keeps complete preflight before `RunStore.create`; it only removes tool-based scheduling eligibility.

- [ ] **Step 7: Remove classification from persistence and boundary adapters**

In `src/subagents/run-store.ts`, remove the `writer` property from `makeManifest` so the final persisted agent is:

```ts
agent: {
  name: task.agent.name,
  description: task.agent.description,
  model: task.agent.model,
  thinking: task.agent.thinking,
  ...(task.agent.tools === undefined ? {} : { tools: task.agent.tools }),
  providerExtensions: task.agent.providerExtensions,
  definitionPath: task.agent.definitionPath,
},
```

In `src/subagents/batch.ts`, remove both policy error imports and their branches from `withErrorMessage`. In `src/subagents/index.ts`, remove both imports and both `instanceof` checks from `isSubagentError`. Do not change rollback, cancellation, progress, or exception formatting for the remaining errors.

- [ ] **Step 8: Update typed fixtures and direct contract assertions**

Remove `writer` from every `ResolvedTask` or manifest fixture in:

- `src/subagents/child-command.test.ts`;
- `src/subagents/run-executor.test.ts`;
- `src/subagents/run-store.test.ts`;
- `src/subagents/batch.test.ts`; and
- `src/subagents/schemas.test.ts`.

In `src/subagents/run-store.test.ts`, decode once and assert the exact persisted agent shape:

```ts
const persistedManifest = decodeRunManifestJson(manifestRaw);
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
```

Replace every role-coded fixture name (`reviewer`, `reader`, `writer`, `worker`, `scout`, or `implementer`) with `alpha`, `beta`, `gamma`, or `agent-N` throughout `schemas.test.ts`, `agents.test.ts`, `preflight.test.ts`, `batch.test.ts`, `child-command.test.ts`, `run-executor.test.ts`, `run-store.test.ts`, `index.test.ts`, `progress.test.ts`, and `render.test.ts`. Update matching descriptions, definition paths, request objects, rendered labels, and expected text in the same assertion; keep behavior, ordering, statuses, and non-name rendering expectations unchanged.

Delete the old tests that expect unsafe-reader or multiple-writer rejection. Keep and rename the provider-provenance cases so they still cover:

- safe-name external overrides;
- missing, SDK, synthetic, and duplicate providers;
- external paths that are absent or not regular files;
- base-directory resolution and canonical-path deduplication; and
- reserved `complete_subagent` and `subagent` names.

- [ ] **Step 9: Use role-neutral real-process fixtures and assert unrestricted overlap**

In `src/subagents/subagents.integration.test.ts`, advertise all built-in tools used by the definitions:

```ts
const parent = (cwd: string): ParentSnapshot => ({
  cwd,
  model: "fake-provider/fake-model",
  thinking: "off",
  tools: ["read", "bash", "edit", "write"].map((name) => ({
    name,
    source: "builtin",
    path: `<builtin:${name}>`,
  })),
});
```

Write three supported definitions with no classification field:

```ts
const definitions = [
  {
    name: "alpha",
    description: "Integration alpha",
    tools: "read",
  },
  {
    name: "beta",
    description: "Integration beta",
    tools: "bash",
  },
  {
    name: "gamma",
    description: "Integration gamma",
    tools: "edit, write",
  },
] as const;

yield *
  Effect.forEach(
    definitions,
    ({ name, description, tools }) =>
      fileSystem.writeTextFile(
        path.join(directory, `${name}.md`),
        `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\nHandle the delegated task and report the result.\n`,
        { mode: 0o600 },
      ),
    { discard: true },
  );
```

Use this task type:

```ts
type AgentName = "alpha" | "beta" | "gamma";

const task = (agent: AgentName, mode: string, id: string, delay = 80) => ({
  agent,
  task: `${mode}\n${id}\ndelay=${delay}\n`,
});
```

Use `alpha` for existing single-agent, failure, rollback, cancellation, and streaming cases. Replace the two old classification concurrency cases with one real-process test:

```ts
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
```

In the private-artifact integration case, decode `result.artifacts.manifestPath` and assert `manifest.agent` has no `writer` property. This covers the real filesystem path as well as the `RunStore` unit test.

- [ ] **Step 10: Run focused subagent tests**

Run:

```bash
bun --bun vitest run \
  src/subagents/schemas.test.ts \
  src/subagents/agents.test.ts \
  src/subagents/preflight.test.ts \
  src/subagents/run-store.test.ts \
  src/subagents/batch.test.ts \
  src/subagents/child-command.test.ts \
  src/subagents/run-executor.test.ts \
  src/subagents/index.test.ts \
  src/subagents/subagents.integration.test.ts \
  src/subagents/progress.test.ts \
  src/subagents/render.test.ts \
  --reporter dot
```

Expected: PASS with no policy-rejection test and with a real three-agent overlap assertion.

- [ ] **Step 11: Run TypeScript and obsolete-symbol checks**

Run:

```bash
bun run typecheck
if rg -n '\b(writer|UnsafeReaderError|WriterPolicyError|READER_SAFE_TOOLS)\b' \
  src/subagents -g '*.ts' -g '!*.test.ts'; then
  echo "obsolete runtime mutation-classification symbol remains" >&2
  exit 1
fi
if rg -n "\\b(reader|reviewer|worker|scout|implementer)\\b|\\bwriter-[0-9]+\\b|name: writer|(?:agent|name|subject):\\s*[\"']writer[\"']|(?:definition|discoveredAgent|task)\\([\"']writer[\"']" \
  src/subagents -g '*.test.ts'; then
  echo "role-coded fixture name remains" >&2
  exit 1
fi
```

Expected: typechecking passes; `rg` prints no matches and the shell exits successfully.

- [ ] **Step 12: Commit the contract removal**

```bash
git add \
  src/subagents/schemas.ts \
  src/subagents/schemas.test.ts \
  src/subagents/agents.ts \
  src/subagents/agents.test.ts \
  src/subagents/preflight.ts \
  src/subagents/preflight.test.ts \
  src/subagents/errors.ts \
  src/subagents/run-store.ts \
  src/subagents/run-store.test.ts \
  src/subagents/batch.ts \
  src/subagents/batch.test.ts \
  src/subagents/index.ts \
  src/subagents/index.test.ts \
  src/subagents/child-command.test.ts \
  src/subagents/run-executor.test.ts \
  src/subagents/subagents.integration.test.ts \
  src/subagents/progress.test.ts \
  src/subagents/render.test.ts
git commit -m "refactor(subagents): remove mutation classification"
```

Expected: one commit containing the complete executable and persisted contract change, with no documentation mixed into it.

---

### Task 2: Align Living and Historical Documentation

**Files:**

- Modify: `docs/specs/subagents.md:13-47,97`
- Modify: `docs/superpowers/specs/2026-07-12-lightweight-subagent-execution-engine-design.md:15-38,72-106,180-205,233-276`
- Modify: `docs/superpowers/specs/2026-07-10-lightweight-subagent-extension-design.md:10-32,85-115,145-181,433-446,481-524,549-568`
- Modify: `docs/superpowers/plans/2026-07-12-lightweight-subagent-execution-engine.md:11-25,42-55,76-87,504-593,659-735,1079-1087,1305-1316,1409-1412,1496-1506`

**Interfaces:**

- Consumes: the final source and test contract from Task 1 and the approved design at `docs/superpowers/specs/2026-07-14-subagent-unrestricted-batches-design.md`.
- Produces: one consistent written contract in which definitions have five supported fields, preflight has no mutation classification, and every valid one-to-three-task batch may run concurrently.

- [ ] **Step 1: Update the living subagents specification**

In `docs/specs/subagents.md`, replace the frontmatter table with exactly these fields:

```markdown
| Field         | Required | Contract                                                     |
| ------------- | -------: | ------------------------------------------------------------ |
| `name`        |      yes | Trimmed, non-empty, single-line public identifier            |
| `description` |      yes | Trimmed, non-empty, single-line description                  |
| `model`       |       no | Pi model pattern or canonical model identifier               |
| `thinking`    |       no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools`       |       no | Non-empty comma-separated unique tool allowlist              |
```

Replace `## Writer and Tool Policy` with:

```markdown
## Tool Policy

Tool allowlists control child tool availability and external provider loading; they do not classify agents or affect whether tasks may run concurrently. An omitted allowlist leaves Pi's normal child tool set available, while a declared allowlist is passed to the child together with `complete_subagent`.

Children start with normal extension discovery disabled. For every declared tool, preflight requires exactly one parent-reported provider. Built-ins need no extension. SDK tools, synthetic provider paths, missing or ambiguous provenance, and non-file providers are rejected. Loadable external provider paths are canonicalized and deduplicated in first-use order. The child loads only the Subagents entrypoint and those required provider extensions; `subagent` and `complete_subagent` are reserved and cannot be requested by a definition.

Pi 0.80.6 exposes only the winning registration for each tool through its public tool inventory. Core preflight rejects duplicates when they are supplied, but the live adapter cannot detect registrations Pi already collapsed and therefore validates only the visible winning provider.

Disabling extension discovery does not disable normal project context discovery. Project skills follow Pi's saved non-interactive trust decision for each child working directory; the extension does not force project trust.
```

In the discovery section, state that the resolved execution data copied into the manifest contains identity, model, thinking, tools, provider extensions, and definition path. In the milestone boundary, remove `parallel writers`; keep chains, management, tmux, scheduling, acceptance, worktrees, merging, pruning, project-local definitions, and nested delegation as milestone-two exclusions.

- [ ] **Step 2: Revise the milestone-one execution design**

In `docs/superpowers/specs/2026-07-12-lightweight-subagent-execution-engine-design.md`:

1. Replace the scope's writer-exclusivity bullets with uniform one-to-three-task concurrency.
2. Remove `writer` from the frontmatter table and from the frozen-run description.
3. Replace `## 5. Writer policy` with this section:

```markdown
## 5. Uniform batch policy

A valid request contains one to three tasks. Every accepted task may run concurrently, including tasks whose definitions omit a tool allowlist or declare mutation-capable tools.

Tool allowlists are execution configuration only. They select the child's active tools and determine which external provider extensions preflight must load; they do not create a scheduling class. The batch has no mutation-based scheduling error or override.
```

4. Change the architecture bullet to `batch preflight and uniform concurrency`.
5. Make execution-flow step 3 resolve working directory, model, thinking, tools, and provider extensions; make step 4 reject missing/reserved/ambiguous/non-loadable tools and other ordinary preflight failures.
6. Remove unsafe-reader and writer-policy errors from the error model.
7. Replace classification test scenarios with strict supported frontmatter, mutation-capable tool provenance, and concurrent role-neutral one-to-three-task batches.

Do not change the launch barrier, rollback, cancellation, result ordering, or milestone-two host boundary.

- [ ] **Step 3: Revise the source extension design**

In `docs/superpowers/specs/2026-07-10-lightweight-subagent-extension-design.md`:

- replace writer-exclusivity goals with uniform bounded concurrency;
- remove `writer: true` from the sample definition and remove the `writer` row and scheduling declaration;
- remove `allowParallelWriters` from the parallel request example;
- replace both writer validation rules with `all one-to-three resolved tasks may run concurrently`;
- remove writer-policy violations from tagged errors;
- replace writer/non-writer unit and integration scenarios with role-neutral one-to-three-task concurrency, including mutation-capable allowlists;
- remove the parallel-writer override from security constraints; and
- describe SDD compatibility as parent-controlled sequencing plus uniformly concurrent batches rather than writer/read-only roles.

Retain tmux layout, capacity, reconnection, pane ownership, lifecycle, and watchdog material: those sections are historical milestone-two input and do not conflict with the uniform task policy.

- [ ] **Step 4: Revise the superseded implementation plan**

In `docs/superpowers/plans/2026-07-12-lightweight-subagent-execution-engine.md`, update every classification-dependent instruction while preserving unrelated implementation history:

- Global constraint:

```markdown
- Every valid one-to-three-task batch may run concurrently; tool allowlists affect child availability and provider loading only, never scheduling eligibility.
```

- `ResolvedAgent`: remove `readonly writer: boolean`.
- Strict schema guidance: list only `name`, `description`, `model`, `thinking`, and `tools`, and require an excess-property test for `writer`.
- Error union: remove `UnsafeReaderError` and `WriterPolicyError`.
- Discovery guidance: preserve supported fields only; do not default a classification.
- Preflight tests: cover omitted and mutation-capable allowlists, all retained provider failures, reserved tools, and three accepted tasks.
- Replace the reader-classification implementation step with provider-only tool resolution and explicitly state that it does not affect scheduling.
- Replace the writer-count preflight instruction with freezing the complete resolved array after every task succeeds.
- Batch and integration scenarios: use role-neutral names and require three unrestricted tasks to overlap.
- Living-spec instruction: describe uniform concurrency and selective tool loading instead of writer policy.
- Review instruction: use `single editing owner` rather than `one writer` so process guidance cannot be confused with the removed domain field.

- [ ] **Step 5: Format documentation and scan for contradictions**

Run:

```bash
bunx prettier --write \
  docs/specs/subagents.md \
  docs/superpowers/specs/2026-07-10-lightweight-subagent-extension-design.md \
  docs/superpowers/specs/2026-07-12-lightweight-subagent-execution-engine-design.md \
  docs/superpowers/plans/2026-07-12-lightweight-subagent-execution-engine.md

if rg -n 'UnsafeReaderError|WriterPolicyError|READER_SAFE_TOOLS|allowParallelWriters|writer[- ]policy|writer exclusivity|parallel writers|unsafe reader|reader-safe|non-writer|writer-count|writer classification' \
  docs/specs/subagents.md \
  docs/superpowers/specs/2026-07-10-lightweight-subagent-extension-design.md \
  docs/superpowers/specs/2026-07-12-lightweight-subagent-execution-engine-design.md \
  docs/superpowers/plans/2026-07-12-lightweight-subagent-execution-engine.md; then
  echo "obsolete positive mutation-classification documentation remains" >&2
  exit 1
fi
```

Expected: Prettier succeeds; `rg` prints no matches and the shell exits successfully. The approved 2026-07-14 design is unchanged because it already states the target contract.

- [ ] **Step 6: Commit documentation alignment**

```bash
git add \
  docs/specs/subagents.md \
  docs/superpowers/specs/2026-07-10-lightweight-subagent-extension-design.md \
  docs/superpowers/specs/2026-07-12-lightweight-subagent-execution-engine-design.md \
  docs/superpowers/plans/2026-07-12-lightweight-subagent-execution-engine.md
git commit -m "docs(subagents): align unrestricted batch contract"
```

Expected: one documentation commit; `docs/specs/index.md` remains unchanged because `docs/specs/subagents.md` continues to own the domain.

---

### Task 3: Verify and Review the Complete Change

**Files:**

- Review: all files changed in Tasks 1 and 2
- Modify only if verification or review finds a concrete defect

**Interfaces:**

- Consumes: the executable contract from Task 1 and written contract from Task 2.
- Produces: a validated branch where source, tests, persisted schemas, and documentation all implement the approved unrestricted-batches design.

- [ ] **Step 1: Run the full repository validation**

Run:

```bash
bun run check
```

Expected: source/test/kit typechecks pass, ESLint passes, and all Vitest suites pass.

- [ ] **Step 2: Run diff and repository-boundary checks**

Run:

```bash
git diff --check main...HEAD
test -z "$(git diff --name-only main...HEAD -- .context)"
git status --short
git diff --stat main...HEAD
```

Expected: no whitespace errors, no `.context` changes, a clean worktree, and only the intended subagent implementation/tests plus documentation changes beyond the branch's existing milestone-one diff.

- [ ] **Step 3: Verify design coverage explicitly**

Run:

```bash
if rg -n '\b(writer|UnsafeReaderError|WriterPolicyError|READER_SAFE_TOOLS)\b' \
  src/subagents -g '*.ts' -g '!*.test.ts'; then
  echo "obsolete runtime mutation-classification symbol remains" >&2
  exit 1
fi
if rg -n "\\b(reader|reviewer|worker|scout|implementer)\\b|\\bwriter-[0-9]+\\b|name: writer|(?:agent|name|subject):\\s*[\"']writer[\"']|(?:definition|discoveredAgent|task)\\([\"']writer[\"']" \
  src/subagents -g '*.test.ts'; then
  echo "role-coded fixture name remains" >&2
  exit 1
fi
rg -n 'minItems\(1\)|maxItems\(3\)' src/subagents/schemas.ts
rg -n 'providerExtensions|RESERVED_TOOLS|resolveProviderExtensions' src/subagents/preflight.ts src/subagents/run-store.ts
rg -n 'observed overlap|assertCommonOverlap|request order' src/subagents/batch.test.ts src/subagents/subagents.integration.test.ts
```

Expected:

- the first command prints no matches;
- request cardinality remains one to three;
- provider provenance and persisted provider extensions remain present; and
- unit/integration tests still prove concurrency overlap and ordered results.

- [ ] **Step 4: Request independent code review**

Use `superpowers:requesting-code-review` with comparison range `7d5a24a06ab20a0c0e8475d7454ec3eb78b9604b..HEAD` (the approved-design commit through the implementation tip). Ask the reviewer to verify:

1. no mutation classification survives in runtime or persisted contracts;
2. tool provenance and reserved-tool validation remain intact;
3. all valid one-to-three-task batches can reach concurrent execution;
4. rollback, cancellation, progress, and result ordering were not weakened; and
5. living and historical documentation agree with the approved design.

Require file/line evidence for every finding. Apply accepted fixes with a single editing owner, rerun the focused subagent tests and `bun run check`, and commit fixes as:

```bash
git add src/subagents docs/specs/subagents.md docs/superpowers
git commit -m "fix(subagents): address unrestricted batch review"
```

Omit the commit when review requires no changes.

- [ ] **Step 5: Perform the final specification review**

Compare the final diff against `main` and map changed domains:

- `src/subagents/**` → `docs/specs/subagents.md`;
- test-only role-neutral fixture changes → no additional specification owner;
- no shared service, package entrypoint, dependency, environment variable, or `.context` change.

Confirm `docs/specs/subagents.md` describes the resulting contract and remains under approximately 300 lines. No `docs/specs/index.md` update is required because no specification file is added or renamed.
