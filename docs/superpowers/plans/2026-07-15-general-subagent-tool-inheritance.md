# General Subagent Tool Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an embedded `general` child always selectable, default omitted agent names to it, and give every child one frozen best-effort inheritance of the parent session's active reloadable tools except nested delegation.

**Architecture:** Keep the existing discovery → preflight → durable run → child process pipeline, but separate agent identity from tool capability. Seed discovery with a builtin `general`, resolve one immutable `ToolInheritance` value from `getActiveTools()` plus `getAllTools()` before resolving the batch, share that value across every task, persist it beside agent provenance, and always pass its exact effective names through `--tools` while loading only the completion extension and required file-backed providers.

**Tech Stack:** Bun 1.3, TypeScript 6, Effect 3.22, Effect Schema, TypeBox 1.3, Pi 0.80.7 extension/JSON CLI APIs, Vitest 3.2, `@effect/vitest`.

## Global Constraints

- The approved source is `docs/superpowers/specs/2026-07-15-general-subagent-tool-inheritance-design.md`; preserve its exact builtin identity, role prompt, parent-facing descriptions, and non-goals.
- The builtin name is `general`, its description is `General-purpose isolated task executor`, its source is `builtin`, and omitted model/thinking continue to inherit from the parent.
- Global definitions remain under `<agent-dir>/subagents/agents/*.md`; a valid unique global shadows a builtin of the same name, while invalid or duplicate `general` candidates retain the builtin fallback and diagnostics.
- Definition frontmatter supports exactly `name`, `description`, optional `model`, and optional `thinking`; the removed `tools` field is rejected as unknown with no compatibility migration.
- Each request still contains one to three tasks; `task` is required, `cwd` is optional, and `agent` is optional with decoded default `general`.
- Inherit names from `pi.getActiveTools()` only; use `pi.getAllTools()` only as provider metadata, so configured-but-inactive tools never reach a child.
- Resolve one copied, frozen parent snapshot and one copied, frozen `ToolInheritance` value per invocation; every accepted task shares it unchanged.
- Filter parent `subagent` and `complete_subagent` entries as reserved policy, add `complete_subagent` exactly once, and permit a completion-only child.
- Preserve builtins in active-parent order; load only canonical file-backed provider extensions; omit missing, ambiguous, SDK, synthetic, non-file, or uncanonicalizable providers with visible durable diagnostics instead of failing preflight.
- Every child command keeps JSON print mode, no session, `--no-extensions`, explicit completion/provider extensions, resolved model/thinking, private prompt/task paths, and an unconditional exact `--tools` value.
- Keep model/thinking resolution, one-to-three concurrency, launch barrier, rollback, cancellation, private artifact modes, structured completion, bounded progress/rendering, ordered results, and process cleanup unchanged.
- Use Bun commands and Effect patterns; do not edit `.context/`, add dependencies, add package entrypoints, or use unsafe assertions/non-null assertions.
- Update only the owning living contract `docs/specs/subagents.md`; `docs/specs/extensions.md` and the approved design already describe their resulting domains accurately.

---

## File and Responsibility Map

### Agent catalog and parent API

- Create `src/subagents/general-agent.ts` — own the exact builtin name, description, and role prompt literals without importing discovery types.
- Modify `src/subagents/schemas.ts` — default omitted task agents, remove definition `tools`, and define strict durable agent/tool-inheritance contracts.
- Modify `src/subagents/agents.ts` — mark definitions as builtin/global, seed `general`, and implement global shadow/fallback semantics.
- Modify `src/subagents/preflight.ts` — preserve builtin fallback during lookup and keep resolved agent identity separate from tool capability.
- Modify `src/subagents/index.ts` — expose the optional default in TypeBox descriptions and snapshot active names separately from provider metadata.
- Modify `src/subagents/render.ts` — render omitted raw agent names as `general` before durable resolution exists.

### Tool resolution, persistence, and execution

- Create `src/subagents/tool-inheritance.ts` — resolve active names to one immutable best-effort child capability plan.
- Modify `src/subagents/errors.ts` — remove obsolete fatal `ToolProviderError` from the public error union/formatter.
- Modify `src/subagents/batch.ts` — merge shared inheritance diagnostics with discovery diagnostics without changing child semantic results.
- Modify `src/subagents/run-store.ts` — persist agent provenance and the complete frozen tool plan.
- Modify `src/subagents/child-command.ts` — always pass exact effective tool names and only required provider extensions.
- Leave `src/subagents/run-executor.ts` behavior unchanged; only its typed fixtures and exact argv assertions change.

### Tests and fixtures

- Create `src/subagents/tool-inheritance.test.ts` — cover active ordering, inactive exclusion, reserved tools, provider canonicalization/deduplication, every unsupported provider class, completion-only behavior, and freezing.
- Create `test/fixtures/inherited-tool-provider.ts` — register one inheritable probe plus unrelated tools, including `subagent`, from one reloadable provider file.
- Modify colocated tests under `src/subagents/*.test.ts` for the new request, discovery, resolved-task, manifest, diagnostics, rendering, and argv contracts.
- Modify `test/fixtures/fake-pi.ts` — validate one explicit tool allowlist, reserved-tool absence, completion uniqueness, and observed explicit extension paths in credential-free child processes.
- Modify `src/subagents/subagents.integration.test.ts` — prove omitted-agent execution, external provider inheritance, unsupported omission, nested delegation exclusion, durable evidence, and successful completion.

### Living documentation

- Modify `docs/specs/subagents.md` — replace required named definitions and definition allowlists with builtin fallback, active-parent inheritance, best-effort diagnostics, exact child tools, and new manifest evidence.

No package manifest, dependency, service, process policy, completion schema, status lifecycle, or extension-discovery change is required.

## Frozen Interfaces Between Tasks

Use these names and shapes consistently so later tasks consume earlier work without reinterpretation:

```ts
// src/subagents/general-agent.ts
export const GENERAL_AGENT_NAME = "general" as const;
export const GENERAL_AGENT_DESCRIPTION =
  "General-purpose isolated task executor";
export const GENERAL_AGENT_ROLE_PROMPT = `You are a general-purpose subagent. Complete exactly the delegated task using
available tools.

Treat the task's supplied scope, paths, constraints, acceptance criteria,
validation requirements, and output contract as authoritative. Inspect evidence
rather than guessing. Make only changes required by the task, and do not broaden
scope or make unapproved product or architecture decisions.

If required information is missing, report NEEDS_CONTEXT. If the task cannot be
completed, report BLOCKED. Use DONE_WITH_CONCERNS only when the requested work is
complete but material uncertainty remains. When the task requires a durable
report, write it to the supplied absolute path and return that path through
structured completion.`;

// src/subagents/agents.ts
export type AgentSource = "builtin" | "global";

type DiscoveredAgentBase = AgentFrontmatter & {
  readonly rolePrompt: string;
};

export type DiscoveredAgent =
  | (DiscoveredAgentBase & { readonly source: "builtin" })
  | (DiscoveredAgentBase & {
      readonly source: "global";
      readonly definitionPath: string;
    });

// src/subagents/schemas.ts
export interface ToolInheritance {
  readonly parentActiveToolNames: ReadonlyArray<string>;
  readonly effectiveToolNames: ReadonlyArray<string>;
  readonly providerExtensions: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}

export type RunManifestAgent =
  | {
      readonly name: string;
      readonly description: string;
      readonly model: string;
      readonly thinking: ThinkingLevel;
      readonly source: "builtin";
    }
  | {
      readonly name: string;
      readonly description: string;
      readonly model: string;
      readonly thinking: ThinkingLevel;
      readonly source: "global";
      readonly definitionPath: string;
    };

export interface RunManifest {
  readonly runId: string;
  readonly createdAt: string;
  readonly task: RunManifestTask;
  readonly agent: RunManifestAgent;
  readonly toolInheritance: ToolInheritance;
  readonly artifacts: RunArtifacts;
}

// src/subagents/tool-inheritance.ts
export interface ParentToolProvider {
  readonly name: string;
  readonly source: string;
  readonly path: string;
  readonly baseDir?: string;
}

export interface ParentToolSnapshot {
  readonly cwd: string;
  readonly activeToolNames: ReadonlyArray<string>;
  readonly toolProviders: ReadonlyArray<ParentToolProvider>;
}

export const resolveToolInheritance: (
  parent: ParentToolSnapshot,
) => Effect.Effect<ToolInheritance, never, FileSystemService>;

// src/subagents/preflight.ts
export interface ParentSnapshot extends ParentToolSnapshot {
  readonly model?: string;
  readonly thinking: ThinkingLevel;
}

type ResolvedAgentBase = {
  readonly name: string;
  readonly description: string;
  readonly rolePrompt: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
};

export type ResolvedAgent =
  | (ResolvedAgentBase & { readonly source: "builtin" })
  | (ResolvedAgentBase & {
      readonly source: "global";
      readonly definitionPath: string;
    });

export interface ResolvedTask {
  readonly index: number;
  readonly task: string;
  readonly cwd: string;
  readonly agent: ResolvedAgent;
  readonly toolInheritance: ToolInheritance;
}
```

---

### Task 1: Implement General Catalog and Tool Inheritance End to End

**Files:**

- Create: `src/subagents/general-agent.ts`
- Create: `src/subagents/tool-inheritance.ts`
- Create: `src/subagents/tool-inheritance.test.ts`
- Modify: `src/subagents/schemas.ts:92-111,166-216,256-336,379-432`
- Modify: `src/subagents/agents.ts:13-76,133-258`
- Modify: `src/subagents/preflight.ts:24-75,152-387`
- Modify: `src/subagents/index.ts:50-75,140-152,297-414,552-601`
- Modify: `src/subagents/errors.ts:23-28,66-89`
- Modify: `src/subagents/batch.ts:17-31,160-216,327-342`
- Modify: `src/subagents/run-store.ts:172-197,305-379`
- Modify: `src/subagents/child-command.ts:73-130`
- Modify: `src/subagents/render.ts:22-28,247-258`
- Test: `src/subagents/*.test.ts`
- Test: `src/subagents/subagents.integration.test.ts`

**Interfaces:**

- Consumes: existing strict decoding, discovery, preflight, private run, process, progress, rendering, and ordered-batch contracts.
- Produces: every interface in **Frozen Interfaces Between Tasks**, exact parent/child command composition, and a green Subagents test suite before the first feature commit.
- Task boundary: the request, discovered/resolved agent, parent snapshot, manifest, and child command types change together. Keeping them in one task avoids transitional compatibility fields or commits that do not typecheck.

- [ ] **Step 1: Add failing request, catalog, lookup, transport, and rendering tests**

In `src/subagents/schemas.test.ts`, replace the single-task assertion and frontmatter tool assertions with:

```ts
it("defaults an omitted or undefined agent to general", () => {
  expect(decodeTasks({ tasks: [{ task: " inspect " }] })).toEqual({
    tasks: [{ agent: "general", task: "inspect" }],
  });
  expect(
    decodeTasks({ tasks: [{ agent: undefined, task: "inspect" }] }),
  ).toEqual({ tasks: [{ agent: "general", task: "inspect" }] });
});

it("accepts only identity, model, and thinking frontmatter", () => {
  expect(
    decodeAgentFrontmatter({
      name: " alpha ",
      description: " inspect contracts ",
      model: " provider/model ",
      thinking: "medium",
    }),
  ).toEqual({
    name: "alpha",
    description: "inspect contracts",
    model: "provider/model",
    thinking: "medium",
  });

  expect(() =>
    decodeAgentFrontmatter({
      name: "legacy",
      description: "Legacy allowlist",
      tools: "read, grep",
    }),
  ).toThrow();
});
```

In `src/subagents/agents.test.ts`, update the definition helper to omit `tools`, then add these catalog cases using the existing `layer(...)` filesystem harness:

```ts
it.effect(
  "always exposes builtin general when global discovery is missing",
  () =>
    Effect.gen(function* () {
      const result = yield* discoverAgents;
      expect(result.definitions).toEqual([
        {
          name: "general",
          description: "General-purpose isolated task executor",
          rolePrompt: GENERAL_AGENT_ROLE_PROMPT,
          source: "builtin",
        },
      ]);
      expect(result.catalog).toEqual({ _tag: "Complete" });
    }).pipe(
      Effect.provide(
        layer({ exists: new Map([[definitionsDirectory, false]]) }),
      ),
    ),
);

it.effect("lets one valid global general shadow the builtin", () => {
  const definitionPath = path.join(definitionsDirectory, "general.md");
  return Effect.gen(function* () {
    const result = yield* discoverAgents;
    expect(result.definitions[0]).toEqual({
      name: "general",
      description: "Customized general",
      model: "openai/custom",
      rolePrompt: "Use the approved custom role.",
      source: "global",
      definitionPath,
    });
  }).pipe(
    Effect.provide(
      layer({
        exists: new Map([[definitionsDirectory, true]]),
        directories: new Map([
          [definitionsDirectory, [{ name: "general.md", kind: "file" }]],
        ]),
        contents: new Map([
          [
            definitionPath,
            definition("general", {
              description: "Customized general",
              model: "openai/custom",
              body: "Use the approved custom role.",
            }),
          ],
        ]),
      }),
    ),
  );
});

it.effect("retains builtin general for malformed or duplicate globals", () => {
  const malformed = path.join(definitionsDirectory, "malformed.md");
  const first = path.join(definitionsDirectory, "first.md");
  const second = path.join(definitionsDirectory, "second.md");
  return Effect.gen(function* () {
    const result = yield* discoverAgents;
    expect(result.definitions[0]).toMatchObject({
      name: "general",
      source: "builtin",
    });
    expect(result.diagnostics.map(({ agentName }) => agentName)).toEqual([
      "general",
      "general",
      "general",
    ]);
  }).pipe(
    Effect.provide(
      layer({
        exists: new Map([[definitionsDirectory, true]]),
        directories: new Map([
          [
            definitionsDirectory,
            [malformed, first, second].map((filePath) => ({
              name: path.basename(filePath),
              kind: "file" as const,
            })),
          ],
        ]),
        contents: new Map([
          [
            malformed,
            "---\nname: general\ndescription: Legacy\ntools: read\n---\nLegacy role.",
          ],
          [first, definition("general")],
          [second, definition("general")],
        ]),
      }),
    ),
  );
});

it.effect("keeps builtin when a valid general has an invalid namesake", () => {
  const valid = path.join(definitionsDirectory, "valid-general.md");
  const invalid = path.join(definitionsDirectory, "invalid-general.md");
  return Effect.gen(function* () {
    const result = yield* discoverAgents;
    expect(result.definitions[0]).toMatchObject({
      name: "general",
      source: "builtin",
    });
    expect(result.diagnostics).toEqual([
      {
        definitionPath: invalid,
        agentName: "general",
        message: expect.stringContaining("tools"),
      },
    ]);
  }).pipe(
    Effect.provide(
      layer({
        exists: new Map([[definitionsDirectory, true]]),
        directories: new Map([
          [
            definitionsDirectory,
            [valid, invalid].map((filePath) => ({
              name: path.basename(filePath),
              kind: "file" as const,
            })),
          ],
        ]),
        contents: new Map([
          [valid, definition("general")],
          [
            invalid,
            "---\nname: general\ndescription: Invalid namesake\ntools: read\n---\nInvalid role.",
          ],
        ]),
      }),
    ),
  );
});
```

Keep the combined malformed/duplicate case: one malformed plus two duplicate candidates must yield the three asserted named diagnostics and builtin `general`. The valid-plus-invalid case separately proves that a superficially unique valid definition cannot shadow the fallback when a same-name diagnostic exists. Update existing discovery assertions by changing definition-name expectations from `["valid"]`, `["unique"]`, or `["first"]` to `["general", "valid"]`, `["general", "unique"]`, or `["general", "first"]` respectively; after the reread, expect `["general", "second"]`. In the missing, probe-failure, and unreadable-directory cases, assert `result.definitions` contains exactly one `{ name: "general", source: "builtin" }` match while retaining each existing catalog state and diagnostic assertion.

In `src/subagents/preflight.test.ts`, change both the `request(...)` helper input and `run(...).tasks` option to `{ readonly agent?: string; readonly task: string; readonly cwd?: string }`. Then give `discoveredAgent` a `source` option and make `definitionPath` conditional:

```ts
const discoveredAgent = (
  name: string,
  options: {
    readonly source?: "builtin" | "global";
    readonly model?: string;
    readonly thinking?: ThinkingLevel;
  } = {},
): DiscoveredAgent => {
  const source = options.source ?? "global";
  const base = {
    name,
    description: `${name} description`,
    rolePrompt: `${name} role`,
    source,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
  };
  return Object.freeze(
    source === "builtin"
      ? { ...base, source: "builtin" as const }
      : {
          ...base,
          source: "global" as const,
          definitionPath: `/agent/subagents/agents/${name}.md`,
        },
  );
};
```

Add lookup coverage:

```ts
it.effect(
  "resolves omitted input to builtin general despite catalog failures",
  () =>
    Effect.gen(function* () {
      const result = yield* run({
        definitions: [discoveredAgent("general", { source: "builtin" })],
        catalog: "Unavailable",
        diagnostics: [
          {
            definitionPath: "/agent/subagents/agents",
            message: "permission denied",
          },
          {
            definitionPath: "/agent/subagents/agents/general.md",
            agentName: "general",
            message: "removed tools field",
          },
        ],
        tasks: [{ task: "work" }],
      });
      expect(result[0]?.agent).toMatchObject({
        name: "general",
        source: "builtin",
      });
    }),
);
```

Keep the existing explicit specialized-name success and complete/unavailable/indeterminate/unknown failure assertions.

In `src/subagents/index.test.ts`, assert both schema and copy exactly:

```ts
expect(harness.tool.description).toBe(
  "Run one to three isolated child agents. The `general` agent name is always available through a bundled fallback and is used when an agent name is omitted.",
);
const itemSchema = harness.tool.parameters.properties.tasks.items;
expect(itemSchema.required).toEqual(["task"]);
expect(itemSchema.properties.agent.description).toBe(
  "Optional agent definition name. Defaults to the always-available `general` agent. Specify another name only when intentionally using a specialized global definition.",
);
expect(
  Value.Check(harness.tool.parameters, {
    tasks: [{ task: "Inspect" }],
  }),
).toBe(true);
```

In `src/subagents/render.test.ts`, add:

```ts
it("renders omitted raw agent names as general", () => {
  const lines = renderSubagentCall(
    { tasks: [{ task: "Inspect" }] },
    theme,
  ).render(120);
  expect(lines.join("\n")).toContain("general");
});
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
bun --bun vitest run \
  src/subagents/schemas.test.ts \
  src/subagents/agents.test.ts \
  src/subagents/preflight.test.ts \
  src/subagents/index.test.ts \
  src/subagents/render.test.ts \
  --reporter dot
```

Expected: FAIL because task agents are required, `tools` remains valid frontmatter, no builtin exists, matching diagnostics defeat fallback, and descriptions/rendering do not mention `general`.

- [ ] **Step 3: Add the exact builtin constants and strict decoded default**

Create `src/subagents/general-agent.ts`:

```ts
export const GENERAL_AGENT_NAME = "general" as const;

export const GENERAL_AGENT_DESCRIPTION =
  "General-purpose isolated task executor";

export const GENERAL_AGENT_ROLE_PROMPT = `You are a general-purpose subagent. Complete exactly the delegated task using
available tools.

Treat the task's supplied scope, paths, constraints, acceptance criteria,
validation requirements, and output contract as authoritative. Inspect evidence
rather than guessing. Make only changes required by the task, and do not broaden
scope or make unapproved product or architecture decisions.

If required information is missing, report NEEDS_CONTEXT. If the task cannot be
completed, report BLOCKED. Use DONE_WITH_CONCERNS only when the requested work is
complete but material uncertainty remains. When the task requires a durable
report, write it to the supplied absolute path and return that path through
structured completion.`;
```

In `src/subagents/schemas.ts`, delete `ToolListSchema`, remove `tools` from `AgentFrontmatter` and `AgentFrontmatterSchema`, import `GENERAL_AGENT_NAME`, and define the task field with a decoded default:

```ts
const TaskRequestSchema = Schema.Struct({
  agent: Schema.optionalWith(NonEmptyTrimmedSingleLineStringSchema, {
    default: () => GENERAL_AGENT_NAME,
  }),
  task: NonEmptyTrimmedStringSchema,
  cwd: Schema.optional(NonEmptyTrimmedSingleLineStringSchema),
});

export const SubagentRequestSchema = Schema.Struct({
  tasks: Schema.Array(TaskRequestSchema).pipe(
    Schema.minItems(1),
    Schema.maxItems(3),
  ),
});
```

Remove the old explicit `Schema.Schema<...>` annotations from both request schemas so Effect preserves the optional encoded field and required decoded field. Keep `SubagentTaskRequest.agent: string` required after decoding and remove all frontmatter freezing of `tools`.

- [ ] **Step 4: Seed and merge the catalog, preserve fallback lookup, and advertise the default**

In `src/subagents/agents.ts`, make parsed files global, define the builtin, and centralize merge behavior:

```ts
const builtinGeneral: DiscoveredAgent = Object.freeze({
  name: GENERAL_AGENT_NAME,
  description: GENERAL_AGENT_DESCRIPTION,
  rolePrompt: GENERAL_AGENT_ROLE_PROMPT,
  source: "builtin",
});

const mergeWithBuiltins = (
  globals: ReadonlyArray<DiscoveredAgent>,
  diagnostics: ReadonlyArray<AgentDefinitionDiagnostic>,
): ReadonlyArray<DiscoveredAgent> => {
  const globalGeneral = globals.find(({ name }) => name === GENERAL_AGENT_NAME);
  const globalGeneralIsUncontested =
    globalGeneral !== undefined &&
    !diagnostics.some(({ agentName }) => agentName === GENERAL_AGENT_NAME);
  return Object.freeze([
    globalGeneralIsUncontested ? globalGeneral : builtinGeneral,
    ...globals.filter(({ name }) => name !== GENERAL_AGENT_NAME),
  ]);
};
```

Return `mergeWithBuiltins(...)` for missing, unavailable, indeterminate, empty, and populated global discovery. A parsed filesystem definition must freeze as:

```ts
Object.freeze({
  name: frontmatter.name,
  description: frontmatter.description,
  ...(frontmatter.model === undefined ? {} : { model: frontmatter.model }),
  ...(frontmatter.thinking === undefined
    ? {}
    : { thinking: frontmatter.thinking }),
  rolePrompt,
  source: "global" as const,
  definitionPath,
});
```

In `src/subagents/preflight.ts`, select a builtin before applying matching global diagnostics:

```ts
const definition = discovery.definitions.find(
  (candidate) => candidate.name === name,
);
if (definition?.source === "builtin") return Effect.succeed(definition);

const namedDiagnostics = discovery.diagnostics.filter(
  (candidate) => candidate.agentName === name,
);
if (namedDiagnostics.length > 0) {
  return Effect.fail(
    definitionFailure(
      name,
      "invalid-definition",
      namedDiagnostics,
      `Requested agent has invalid or duplicate definitions: ${diagnosticSummary(namedDiagnostics)}`,
    ),
  );
}
if (definition !== undefined) return Effect.succeed(definition);
```

Freeze resolved provenance with the same discriminant and only copy `definitionPath` in the global branch:

```ts
const freezeResolvedAgent = (
  definition: DiscoveredAgent,
  model: string,
  thinking: ThinkingLevel,
): ResolvedAgent => {
  const base = {
    name: definition.name,
    description: definition.description,
    rolePrompt: definition.rolePrompt,
    model,
    thinking,
  };
  return Object.freeze(
    definition.source === "builtin"
      ? { ...base, source: "builtin" as const }
      : {
          ...base,
          source: "global" as const,
          definitionPath: definition.definitionPath,
        },
  );
};
```

Do not change model/thinking resolution.

In `src/subagents/index.ts`, make TypeBox `agent` optional with the approved parameter description and replace the parent tool description with the approved sentence from Step 1. In `src/subagents/render.ts`, change the raw call type to `agent?: string` and map `agent ?? GENERAL_AGENT_NAME`.

- [ ] **Step 5: Run focused tests and formatting**

Run:

```bash
bun --bun vitest run \
  src/subagents/schemas.test.ts \
  src/subagents/agents.test.ts \
  src/subagents/index.test.ts \
  src/subagents/render.test.ts \
  --reporter dot
bun --bun vitest run src/subagents/preflight.test.ts \
  -t "working directories and agents|model resolution" \
  --reporter dot
bunx prettier --check \
  src/subagents/general-agent.ts \
  src/subagents/schemas.ts \
  src/subagents/agents.ts \
  src/subagents/preflight.ts \
  src/subagents/index.ts \
  src/subagents/render.ts
```

Expected: the catalog/API suites and selected agent/model preflight cases PASS; provider-policy cases remain for the next subcycle. Prettier reports all listed files use the configured style.

#### Tool-resolution subcycle

**Files:**

- Create: `src/subagents/tool-inheritance.ts`
- Create: `src/subagents/tool-inheritance.test.ts`
- Modify: `src/subagents/schemas.ts:183-216,320-336,397-432`
- Modify: `src/subagents/preflight.ts:24-75,210-298,329-387`
- Modify: `src/subagents/index.ts:140-152,297-318,552-601`
- Modify: `src/subagents/errors.ts:23-28,66-89`
- Modify: `src/subagents/batch.ts:17-31,160-216,327-342`
- Test: `src/subagents/preflight.test.ts`
- Test: `src/subagents/index.test.ts`
- Test: `src/subagents/batch.test.ts`

**Interfaces:**

- Consumes: source-discriminated agents from the preceding catalog subcycle, `FileSystemService.stat`/`realPath`, Pi `getActiveTools()`/`getAllTools()`, and existing invocation diagnostics.
- Produces: `ToolInheritance`, `ParentToolProvider`, `ParentToolSnapshot`, `ParentSnapshot.activeToolNames`, `ParentSnapshot.toolProviders`, one shared `ResolvedTask.toolInheritance`, and nonfatal single-line inheritance diagnostics.
- Removes: `ToolProviderError`; unsupported implicit inheritance has no fatal error path.

- [ ] **Step 1: Add failing pure tool-resolution tests**

Create `src/subagents/tool-inheritance.test.ts` using `@effect/vitest`, `FileSystemServiceTest.layer`, and these core cases:

```ts
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { FileSystemServiceTest } from "../../test/services/file-system";
import { FileSystemError } from "../services/file-system";
import { resolveToolInheritance } from "./tool-inheritance";

const file = { kind: "file" as const, mtimeMs: 0, mode: 0o644 };
const directory = { kind: "directory" as const, mtimeMs: 0, mode: 0o755 };

const run = (
  parent: Parameters<typeof resolveToolInheritance>[0],
  config: Parameters<typeof FileSystemServiceTest.layer>[0] = {},
) =>
  resolveToolInheritance(parent).pipe(
    Effect.provide(FileSystemServiceTest.layer(config)),
  );

describe("resolveToolInheritance", () => {
  it.effect(
    "inherits active builtins in order and filters reserved names",
    () =>
      Effect.gen(function* () {
        const result = yield* run({
          cwd: "/repo",
          activeToolNames: ["bash", "subagent", "read", "complete_subagent"],
          toolProviders: [
            { name: "read", source: "builtin", path: "<builtin:read>" },
            { name: "inactive", source: "builtin", path: "<builtin:inactive>" },
            { name: "bash", source: "builtin", path: "<builtin:bash>" },
          ],
        });
        expect(result).toEqual({
          parentActiveToolNames: [
            "bash",
            "subagent",
            "read",
            "complete_subagent",
          ],
          effectiveToolNames: ["bash", "read", "complete_subagent"],
          providerExtensions: [],
          diagnostics: [],
        });
      }),
  );

  it.effect(
    "keeps every active name while deduplicating canonical providers",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            cwd: "/repo",
            activeToolNames: ["search", "lookup", "write"],
            toolProviders: [
              {
                name: "search",
                source: "local",
                path: "providers/search.ts",
              },
              {
                name: "lookup",
                source: "package",
                path: "/aliases/lookup.ts",
              },
              { name: "write", source: "builtin", path: "<builtin:write>" },
            ],
          },
          {
            metadata: new Map([
              ["/repo/providers/search.ts", file],
              ["/aliases/lookup.ts", file],
            ]),
            realPaths: new Map([
              ["/repo/providers/search.ts", "/canonical/provider.ts"],
              ["/aliases/lookup.ts", "/canonical/provider.ts"],
            ]),
          },
        );
        expect(result.effectiveToolNames).toEqual([
          "search",
          "lookup",
          "write",
          "complete_subagent",
        ]);
        expect(result.providerExtensions).toEqual(["/canonical/provider.ts"]);
      }),
  );

  it.effect("turns a provider stat failure into a diagnostic", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          cwd: "/repo",
          activeToolNames: ["missing_file"],
          toolProviders: [
            {
              name: "missing_file",
              source: "local",
              path: "/ext/missing.ts",
            },
          ],
        },
        {
          failures: new Map([
            [
              "stat",
              new Map([
                [
                  "/ext/missing.ts",
                  new FileSystemError({
                    operation: "stat",
                    path: "/ext/missing.ts",
                    message: "not found",
                  }),
                ],
              ]),
            ],
          ]),
        },
      );
      expect(result.effectiveToolNames).toEqual(["complete_subagent"]);
      expect(result.diagnostics).toEqual([
        expect.stringContaining("missing_file"),
      ]);
    }),
  );

  it.effect("omits every unsupported provider class with diagnostics", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          cwd: "/repo",
          activeToolNames: [
            "missing",
            "ambiguous",
            "sdk_bound",
            "synthetic",
            "directory",
            "uncanonicalizable",
          ],
          toolProviders: [
            { name: "ambiguous", source: "builtin", path: "<builtin:a>" },
            { name: "ambiguous", source: "local", path: "/ext/a.ts" },
            { name: "sdk_bound", source: "sdk", path: "<sdk:sdk_bound>" },
            { name: "synthetic", source: "local", path: "<inline>" },
            { name: "directory", source: "local", path: "/ext" },
            {
              name: "uncanonicalizable",
              source: "local",
              path: "/ext/broken.ts",
            },
          ],
        },
        {
          metadata: new Map([
            ["/ext", directory],
            ["/ext/broken.ts", file],
          ]),
          failures: new Map([
            [
              "realPath",
              new Map([
                [
                  "/ext/broken.ts",
                  new FileSystemError({
                    operation: "realPath",
                    path: "/ext/broken.ts",
                    message: "canonicalization denied",
                  }),
                ],
              ]),
            ],
          ]),
        },
      );
      expect(result.effectiveToolNames).toEqual(["complete_subagent"]);
      expect(result.providerExtensions).toEqual([]);
      expect(result.diagnostics).toHaveLength(6);
      for (const name of [
        "missing",
        "ambiguous",
        "sdk_bound",
        "synthetic",
        "directory",
        "uncanonicalizable",
      ]) {
        expect(result.diagnostics.join(" ")).toContain(name);
      }
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.parentActiveToolNames)).toBe(true);
      expect(Object.isFrozen(result.effectiveToolNames)).toBe(true);
      expect(Object.isFrozen(result.providerExtensions)).toBe(true);
      expect(Object.isFrozen(result.diagnostics)).toBe(true);
    }),
  );
});
```

- [ ] **Step 2: Add failing adapter, preflight-sharing, and batch-diagnostic tests**

In `src/subagents/index.test.ts`, make `makeParentHarness` own and expose these mutable inputs, and wire both port methods:

```ts
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
```

Add `activeToolNames` and `tools` as shorthand properties in the existing returned harness object, beside `port` and `runtime`.

Change the snapshot assertion to:

```ts
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
expect(harness.runtimeInput.parent.activeToolNames).not.toBe(
  harness.port.getActiveTools(),
);
expect(harness.runtimeInput.parent.toolProviders).not.toBe(
  harness.port.getAllTools(),
);
```

After the snapshot assertion, mutate both harness arrays and prove the captured value is unchanged:

```ts
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
```

In `src/subagents/preflight.test.ts`, replace the parent helper's `tools` option with the final split snapshot:

```ts
const parent = (
  options: {
    readonly cwd?: string;
    readonly model?: string | false;
    readonly thinking?: ThinkingLevel;
    readonly activeToolNames?: ReadonlyArray<string>;
    readonly toolProviders?: ParentSnapshot["toolProviders"];
  } = {},
): ParentSnapshot => ({
  cwd: options.cwd ?? "/repo",
  ...(options.model === false
    ? {}
    : { model: options.model ?? "openai/parent" }),
  thinking: options.thinking ?? "medium",
  activeToolNames: options.activeToolNames ?? ["read", "grep"],
  toolProviders: options.toolProviders ?? [builtin("read"), builtin("grep")],
});
```

Delete the old `preflight uniform tool policy` and `preflight tool-provider provenance` suites; their allowlist behavior is obsolete and the new resolver suite owns every provider case. Replace them with a parent snapshot and assert one shared plan:

```ts
it.effect("resolves and shares one frozen tool plan across every task", () =>
  Effect.gen(function* () {
    const result = yield* run({
      definitions: [discoveredAgent("alpha"), discoveredAgent("beta")],
      parent: parent({
        activeToolNames: ["read"],
        toolProviders: [builtin("read")],
      }),
    });
    expect(result[0]?.toolInheritance).toBe(result[1]?.toolInheritance);
    expect(result[0]?.toolInheritance).toEqual({
      parentActiveToolNames: ["read"],
      effectiveToolNames: ["read", "complete_subagent"],
      providerExtensions: [],
      diagnostics: [],
    });
  }),
);
```

In `src/subagents/batch.test.ts`, update the central `resolvedTask` helper to the final `agent` plus `toolInheritance` shape shown in the durable-evidence subcycle. Add an optional `toolDiagnostics: ReadonlyArray<string> = []` helper parameter and freeze it into `toolInheritance.diagnostics`. Make the warning test pass `['Inherited tool "sdk_bound" omitted: SDK tools cannot be recreated in a child process']`; assert that exact string appears once in both progress and `BatchExecutionResult.diagnostics` while the child still completes.

- [ ] **Step 3: Run the new and affected tests to verify RED**

Run:

```bash
bun --bun vitest run \
  src/subagents/tool-inheritance.test.ts \
  src/subagents/preflight.test.ts \
  src/subagents/index.test.ts \
  src/subagents/batch.test.ts \
  --reporter dot
```

Expected: FAIL because the resolver and split snapshot fields do not exist, preflight still resolves definition allowlists per task, unsupported providers are fatal, and batch diagnostics contain only discovery warnings.

- [ ] **Step 4: Implement the best-effort resolver**

First add the final immutable value type to `src/subagents/schemas.ts`:

```ts
export interface ToolInheritance {
  readonly parentActiveToolNames: ReadonlyArray<string>;
  readonly effectiveToolNames: ReadonlyArray<string>;
  readonly providerExtensions: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}
```

Then create `src/subagents/tool-inheritance.ts` with the frozen interfaces and this resolution loop:

```ts
import path from "node:path";
import { Effect, Either } from "effect";
import { FileSystemService } from "../services/file-system";
import type { ToolInheritance } from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";

const RESERVED_PARENT_TOOL_NAMES = new Set(["subagent", "complete_subagent"]);
const CHILD_COMPLETION_TOOL_NAME = "complete_subagent";

export interface ParentToolProvider {
  readonly name: string;
  readonly source: string;
  readonly path: string;
  readonly baseDir?: string;
}

export interface ParentToolSnapshot {
  readonly cwd: string;
  readonly activeToolNames: ReadonlyArray<string>;
  readonly toolProviders: ReadonlyArray<ParentToolProvider>;
}

const diagnostic = (
  toolName: string,
  message: string,
  provider?: ParentToolProvider,
  providerPath?: string,
): string =>
  sanitizeTerminalText(
    `Inherited tool "${toolName}" omitted: ${message}${
      provider === undefined ? "" : `; source=${provider.source}`
    }${providerPath === undefined ? "" : `; provider=${providerPath}`}`,
  )
    .replace(/\s+/gu, " ")
    .trim();

const freeze = (
  parentActiveToolNames: ReadonlyArray<string>,
  effectiveToolNames: ReadonlyArray<string>,
  providerExtensions: ReadonlyArray<string>,
  diagnostics: ReadonlyArray<string>,
): ToolInheritance =>
  Object.freeze({
    parentActiveToolNames: Object.freeze([...parentActiveToolNames]),
    effectiveToolNames: Object.freeze([...effectiveToolNames]),
    providerExtensions: Object.freeze([...providerExtensions]),
    diagnostics: Object.freeze([...diagnostics]),
  });

export const resolveToolInheritance = (
  parent: ParentToolSnapshot,
): Effect.Effect<ToolInheritance, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const effectiveToolNames: Array<string> = [];
    const providerExtensions: Array<string> = [];
    const diagnostics: Array<string> = [];
    const seenToolNames = new Set<string>();
    const seenProviders = new Set<string>();

    for (const toolName of parent.activeToolNames) {
      if (seenToolNames.has(toolName)) continue;
      seenToolNames.add(toolName);
      if (RESERVED_PARENT_TOOL_NAMES.has(toolName)) continue;

      const providers = parent.toolProviders.filter(
        ({ name }) => name === toolName,
      );
      if (providers.length !== 1) {
        diagnostics.push(
          diagnostic(
            toolName,
            providers.length === 0
              ? "provider metadata is missing"
              : "provider metadata is ambiguous",
          ),
        );
        continue;
      }

      const provider = providers[0];
      if (provider === undefined) {
        diagnostics.push(diagnostic(toolName, "provider metadata is missing"));
        continue;
      }
      if (provider.source === "builtin") {
        effectiveToolNames.push(toolName);
        continue;
      }
      if (provider.source === "sdk") {
        diagnostics.push(
          diagnostic(
            toolName,
            "SDK tools cannot be recreated in a child process",
            provider,
          ),
        );
        continue;
      }
      if (/^<.*>$/u.test(provider.path)) {
        diagnostics.push(
          diagnostic(
            toolName,
            "synthetic provider paths are not reloadable",
            provider,
          ),
        );
        continue;
      }

      const providerPath = path.resolve(
        provider.baseDir ?? parent.cwd,
        provider.path,
      );
      const metadata = yield* Effect.either(fileSystem.stat(providerPath));
      if (Either.isLeft(metadata)) {
        diagnostics.push(
          diagnostic(toolName, metadata.left.message, provider, providerPath),
        );
        continue;
      }
      if (metadata.right.kind !== "file") {
        diagnostics.push(
          diagnostic(
            toolName,
            "provider must be an existing regular file",
            provider,
            providerPath,
          ),
        );
        continue;
      }

      const canonical = yield* Effect.either(fileSystem.realPath(providerPath));
      if (Either.isLeft(canonical)) {
        diagnostics.push(
          diagnostic(toolName, canonical.left.message, provider, providerPath),
        );
        continue;
      }

      effectiveToolNames.push(toolName);
      if (!seenProviders.has(canonical.right)) {
        seenProviders.add(canonical.right);
        providerExtensions.push(canonical.right);
      }
    }

    effectiveToolNames.push(CHILD_COMPLETION_TOOL_NAME);
    return freeze(
      parent.activeToolNames,
      effectiveToolNames,
      providerExtensions,
      diagnostics,
    );
  });
```

Keep ambiguous-provider behavior unit-testable through the injected snapshot; Pi 0.80.7 live inventory exposes only the winning registration, so do not invent a second provenance source.

- [ ] **Step 5: Snapshot active/all tools separately and resolve once before tasks**

In `src/subagents/index.ts`, add `getActiveTools` to `ParentToolRegistrationPort`, wire it to `pi.getActiveTools()`, and replace `snapshotParent` with:

```ts
const snapshotParent = (
  port: ParentToolRegistrationPort,
  context: ParentToolExecutionContext,
): ParentSnapshot => {
  const activeToolNames = Object.freeze([...port.getActiveTools()]);
  const toolProviders = Object.freeze(
    port.getAllTools().map(({ name, sourceInfo }) =>
      Object.freeze({
        name,
        source: sourceInfo.source,
        path: sourceInfo.path,
        ...(sourceInfo.baseDir === undefined
          ? {}
          : { baseDir: sourceInfo.baseDir }),
      }),
    ),
  );
  return Object.freeze({
    cwd: context.cwd,
    ...(context.model === undefined
      ? {}
      : { model: `${context.model.provider}/${context.model.id}` }),
    thinking: port.getThinkingLevel(),
    activeToolNames,
    toolProviders,
  });
};
```

In `src/subagents/preflight.ts`, delete the definition allowlist resolver, extend `ParentSnapshot` from `ParentToolSnapshot`, and resolve once:

```ts
export const preflight = (input: PreflightInput) =>
  Effect.gen(function* () {
    const toolInheritance = yield* resolveToolInheritance(input.parent);
    const resolved = yield* Effect.forEach(input.request.tasks, (task, index) =>
      resolveTask(task, index, input, toolInheritance),
    );
    return Object.freeze(resolved);
  });
```

`resolveTask` must attach the same `toolInheritance` object by reference. Remove `tools` and `providerExtensions` from `ResolvedAgent` and freeze only source/path identity plus model/thinking/prompt fields.

In `src/subagents/errors.ts`, delete `ToolProviderError`, its union member, and its formatter switch branch. Remove corresponding imports/clone branches from `src/subagents/index.ts` and `src/subagents/batch.ts`.

In `src/subagents/batch.ts`, merge the shared diagnostics once:

```ts
const toolDiagnostics = tasks[0]?.toolInheritance.diagnostics ?? [];
const diagnostics = Object.freeze([
  ...discovery.diagnostics.map(formatDiscoveryDiagnostic),
  ...toolDiagnostics,
]);
```

Do not append these strings to `RunResult.diagnostics`; they remain invocation-level structured details and durable manifest evidence, separate from child execution/semantic concerns.

- [ ] **Step 6: Run focused resolver tests and formatting**

Run:

```bash
bun --bun vitest run \
  src/subagents/tool-inheritance.test.ts \
  src/subagents/preflight.test.ts \
  src/subagents/index.test.ts \
  src/subagents/batch.test.ts \
  --reporter dot
bunx prettier --check \
  src/subagents/tool-inheritance.ts \
  src/subagents/tool-inheritance.test.ts \
  src/subagents/preflight.ts \
  src/subagents/index.ts \
  src/subagents/errors.ts \
  src/subagents/batch.ts
```

Expected: selected tests PASS and Prettier reports no changes needed. Run the full TypeScript projects only after the next subcycle updates every `ResolvedTask` and `ParentSnapshot` fixture atomically.

#### Durable-evidence and child-command subcycle

**Files:**

- Modify: `src/subagents/schemas.ts:183-216,320-336,397-432`
- Modify: `src/subagents/run-store.ts:172-197,305-379`
- Modify: `src/subagents/child-command.ts:73-130`
- Test: `src/subagents/schemas.test.ts`
- Test: `src/subagents/run-store.test.ts`
- Test: `src/subagents/child-command.test.ts`
- Test: `src/subagents/run-executor.test.ts`
- Test: `src/subagents/batch.test.ts`
- Test: `src/subagents/progress.test.ts`
- Test: `src/subagents/render.test.ts`

**Interfaces:**

- Consumes: shared `ResolvedTask.toolInheritance` and source-discriminated `ResolvedAgent` from the preceding catalog and tool-resolution subcycles.
- Produces: strict `RunManifest.agent`, strict `RunManifest.toolInheritance`, global-only `definitionPath`, unconditional `--tools`, and completion/provider extension argv derived only from frozen preflight data.
- Preserves: `RunResult`, status records, prompt composition, process invocation ownership, and model-facing result text.

- [ ] **Step 1: Add failing durable-schema and run-store tests**

In `src/subagents/schemas.test.ts`, replace the manifest fixture's agent/tool fields with:

```ts
agent: {
  name: "alpha",
  description: "Inspect contracts",
  model: "provider/model",
  thinking: "medium",
  source: "global",
  definitionPath: "/agents/alpha.md",
},
toolInheritance: {
  parentActiveToolNames: ["read", "grep", "subagent"],
  effectiveToolNames: ["read", "grep", "complete_subagent"],
  providerExtensions: ["/ext/alpha.ts"],
  diagnostics: [],
},
```

Add source/path and completion invariants:

```ts
it("enforces builtin/global provenance and one completion tool", () => {
  expect(
    decodeRunManifest({
      ...manifest,
      agent: {
        name: "general",
        description: "General-purpose isolated task executor",
        model: "provider/model",
        thinking: "medium",
        source: "builtin",
      },
    }).agent,
  ).not.toHaveProperty("definitionPath");

  expect(() =>
    decodeRunManifest({
      ...manifest,
      agent: { ...manifest.agent, source: "builtin" },
    }),
  ).toThrow();
  expect(() =>
    decodeRunManifest({
      ...manifest,
      agent: { ...manifest.agent, definitionPath: undefined },
    }),
  ).toThrow();
  expect(() =>
    decodeRunManifest({
      ...manifest,
      toolInheritance: {
        ...manifest.toolInheritance,
        effectiveToolNames: ["read"],
      },
    }),
  ).toThrow();
  expect(() =>
    decodeRunManifest({
      ...manifest,
      toolInheritance: {
        ...manifest.toolInheritance,
        effectiveToolNames: ["complete_subagent", "complete_subagent"],
      },
    }),
  ).toThrow();
});
```

In `src/subagents/run-store.test.ts`, change `resolvedTask()` to the frozen interface map and assert the persisted manifest exactly:

```ts
agent: {
  name: "alpha",
  description: "Handle delegated work",
  model: "openai-codex/gpt-5.4",
  thinking: "high",
  source: "global",
  definitionPath: "/agents/alpha.md",
},
toolInheritance: {
  parentActiveToolNames: ["read", "grep", "sdk_bound"],
  effectiveToolNames: ["read", "grep", "complete_subagent"],
  providerExtensions: ["/extensions/search.ts"],
  diagnostics: [
    'Inherited tool "sdk_bound" omitted: SDK tools cannot be recreated in a child process; source=sdk',
  ],
},
```

In the same real-filesystem test, give `serviceLayer` the ids `["run-uuid", "general-uuid"]`, import `GENERAL_AGENT_DESCRIPTION` and `GENERAL_AGENT_ROLE_PROMPT`, then add this builtin case:

```ts
const generalTask: ResolvedTask = Object.freeze({
  ...resolvedTask("Complete the delegated task."),
  agent: Object.freeze({
    name: "general",
    description: GENERAL_AGENT_DESCRIPTION,
    rolePrompt: GENERAL_AGENT_ROLE_PROMPT,
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    source: "builtin",
  }),
});
const generalRun = yield * store.create(generalTask);
const generalManifest = decodeRunManifestJson(
  yield * fileSystem.readTextFile(generalRun.artifacts.manifestPath),
);
expect(generalManifest.agent).toEqual({
  name: "general",
  description: GENERAL_AGENT_DESCRIPTION,
  model: "openai-codex/gpt-5.4",
  thinking: "high",
  source: "builtin",
});
expect(generalManifest.agent).not.toHaveProperty("definitionPath");
expect(yield * fileSystem.readTextFile(generalRun.artifacts.systemPromptPath))
  .toBe(`${GENERAL_AGENT_ROLE_PROMPT}

Do not launch subagents or delegate this task. Complete it yourself.

Before finishing, call complete_subagent exactly once as your sole final tool call. Use status DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED; provide a concise single-line summary; and provide an absolute reportPath when a report is required.
`);
```

- [ ] **Step 2: Add failing exact child-command tests**

In `src/subagents/child-command.test.ts`, replace the fixture's agent tool fields with top-level task inheritance:

```ts
const resolvedTask = (
  toolInheritance: ResolvedTask["toolInheritance"] = {
    parentActiveToolNames: ["read", "web_search", "subagent"],
    effectiveToolNames: ["read", "web_search", "complete_subagent"],
    providerExtensions: [
      "/extensions/provider.ts",
      "/extensions/../extensions/provider.ts",
    ],
    diagnostics: [],
  },
): ResolvedTask => ({
  index: 0,
  task: taskText,
  cwd: "/repo/worktree",
  agent: {
    name: "alpha",
    description: "Inspect implementation",
    rolePrompt,
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    source: "global",
    definitionPath: "/agents/alpha.md",
  },
  toolInheritance,
});
```

Keep the exact existing argv assertion but derive extensions from `toolInheritance.providerExtensions`. Replace the omitted-allowlist test with:

```ts
it("always passes an explicit completion-only tool list", () => {
  const invocation = buildChildInvocation(
    {
      task: resolvedTask({
        parentActiveToolNames: ["subagent"],
        effectiveToolNames: ["complete_subagent"],
        providerExtensions: [],
        diagnostics: [],
      }),
      artifacts,
      parentEnv: {},
      completionEntrypoint: "/repo/src/subagents/index.ts",
    },
    runtime("/compiled/pi", ["/compiled/pi"]),
  );

  const toolsIndex = invocation.args.indexOf("--tools");
  expect(toolsIndex).toBeGreaterThanOrEqual(0);
  expect(invocation.args[toolsIndex + 1]).toBe("complete_subagent");
  expect(invocation.args.filter((value) => value === "--tools")).toHaveLength(
    1,
  );
});
```

Add this exact multi-tool-provider assertion:

```ts
it("loads a selected provider without activating its unrelated tools", () => {
  const invocation = buildChildInvocation({
    task: resolvedTask({
      parentActiveToolNames: ["inherited_probe", "subagent"],
      effectiveToolNames: ["inherited_probe", "complete_subagent"],
      providerExtensions: ["/extensions/multi-tool-provider.ts"],
      diagnostics: [],
    }),
    artifacts,
    parentEnv: {},
    completionEntrypoint: "/completion.ts",
  });
  const toolsIndex = invocation.args.indexOf("--tools");
  expect(invocation.args[toolsIndex + 1]).toBe(
    "inherited_probe,complete_subagent",
  );
  expect(invocation.args).toContain("/extensions/multi-tool-provider.ts");
  expect(invocation.args[toolsIndex + 1]).not.toContain("subagent,");
  expect(invocation.args[toolsIndex + 1]).not.toContain("provider_extra");
});
```

- [ ] **Step 3: Run schema, store, command, and executor tests to verify RED**

Run:

```bash
bun --bun vitest run \
  src/subagents/schemas.test.ts \
  src/subagents/run-store.test.ts \
  src/subagents/child-command.test.ts \
  src/subagents/run-executor.test.ts \
  --reporter dot
```

Expected: FAIL because the manifest still stores definition allowlists under the agent, requires every definition path, lacks tool inheritance evidence, and omits `--tools` for unrestricted agents.

- [ ] **Step 4: Make durable schemas strict and immutable**

In `src/subagents/schemas.ts`, add unique-name schemas and the source-discriminated agent union:

```ts
const UniqueToolNamesSchema = Schema.Array(
  NonEmptyTrimmedSingleLineStringSchema,
).pipe(
  Schema.filter((value) => new Set(value).size === value.length, {
    description: "unique tool names",
  }),
);

const EffectiveToolNamesSchema = UniqueToolNamesSchema.pipe(
  Schema.minItems(1),
  Schema.filter(
    (value) =>
      value.filter((name) => name === "complete_subagent").length === 1,
    {
      description: "effective tools containing complete_subagent exactly once",
    },
  ),
);

export const ToolInheritanceSchema: Schema.Schema<ToolInheritance> =
  Schema.Struct({
    parentActiveToolNames: UniqueToolNamesSchema,
    effectiveToolNames: EffectiveToolNamesSchema,
    providerExtensions: Schema.Array(AbsolutePathSchema).pipe(
      Schema.filter((value) => new Set(value).size === value.length, {
        description: "unique canonical provider paths",
      }),
    ),
    diagnostics: DiagnosticsSchema,
  });

const RunManifestAgentBase = {
  name: NonEmptyTrimmedSingleLineStringSchema,
  description: NonEmptyTrimmedSingleLineStringSchema,
  model: NonEmptyTrimmedSingleLineStringSchema,
  thinking: ThinkingLevelSchema,
};

const RunManifestAgentSchema: Schema.Schema<RunManifestAgent> = Schema.Union(
  Schema.Struct({ ...RunManifestAgentBase, source: Schema.Literal("builtin") }),
  Schema.Struct({
    ...RunManifestAgentBase,
    source: Schema.Literal("global"),
    definitionPath: AbsolutePathSchema,
  }),
);
```

Include `toolInheritance: ToolInheritanceSchema` in `RunManifestSchema`. Freeze each nested array. In `freezeRunManifestAgent`, branch on `value.source`; in `freezeRunManifest`, call a dedicated `freezeToolInheritance` that copies every array. Do not allow a builtin path or a global without one.

- [ ] **Step 5: Persist the plan and always build exact tools/providers**

In `src/subagents/run-store.ts`, replace the manifest agent block with:

```ts
agent: {
  name: task.agent.name,
  description: task.agent.description,
  model: task.agent.model,
  thinking: task.agent.thinking,
  source: task.agent.source,
  ...(task.agent.source === "global"
    ? { definitionPath: task.agent.definitionPath }
    : {}),
},
toolInheritance: task.toolInheritance,
```

Keep `makeSystemPrompt` unchanged so the runtime appends nested-delegation and structured-completion contracts exactly once.

In `src/subagents/child-command.ts`, read provider paths and tools only from the frozen task plan:

```ts
const extensions = canonicalExtensions(
  input.completionEntrypoint,
  input.task.toolInheritance.providerExtensions,
);
const extensionArgs = extensions.flatMap((extensionPath) => [
  "--extension",
  extensionPath,
]);
const toolArgs = [
  "--tools",
  input.task.toolInheritance.effectiveToolNames.join(","),
];
```

Keep `--no-extensions` before explicit extension arguments and keep completion first. Do not recompute, append, filter, or inspect parent state in this module.

- [ ] **Step 6: Update typed fixtures without changing unrelated behavior**

For every `ResolvedTask` fixture in `src/subagents/batch.test.ts`, `src/subagents/run-executor.test.ts`, `src/subagents/progress.test.ts`, and `src/subagents/render.test.ts`, use this shape and vary only values the test owns:

```ts
agent: {
  name: "alpha",
  description: "Alpha",
  rolePrompt: "Act as alpha.",
  model: "openai-codex/gpt-5.4",
  thinking: "high",
  source: "global",
  definitionPath: "/agents/alpha.md",
},
toolInheritance: Object.freeze({
  parentActiveToolNames: Object.freeze(["read"]),
  effectiveToolNames: Object.freeze(["read", "complete_subagent"]),
  providerExtensions: Object.freeze([]),
  diagnostics: Object.freeze([]),
}),
```

Update exact executor argv expectations so every launch includes `--tools read,complete_subagent`. Do not loosen existing lifecycle, progress, ordering, rollback, or privacy assertions.

Replace `parentRuntimeInput(...).parent` in `src/subagents/index.test.ts` with the empty inventory below:

```ts
parent: {
  cwd: "/parent/project",
  model: "openai-codex/gpt-5.4",
  thinking: "high",
  activeToolNames: [],
  toolProviders: [],
},
```

In `src/subagents/batch.test.ts`, replace its top-level `parent` constant with:

```ts
const parent: ParentSnapshot = {
  cwd: "/repo",
  model: "openai/parent",
  thinking: "medium",
  activeToolNames: ["read"],
  toolProviders: [{ name: "read", source: "builtin", path: "<builtin:read>" }],
};
```

In `src/subagents/subagents.integration.test.ts`, remove `tools` from the definitions written by `writeDefinitions`:

```ts
const definitions = [
  { name: "alpha", description: "Integration alpha" },
  { name: "beta", description: "Integration beta" },
  { name: "gamma", description: "Integration gamma" },
] as const;
yield *
  Effect.forEach(
    definitions,
    ({ name, description }) =>
      fileSystem.writeTextFile(
        path.join(directory, `${name}.md`),
        `---\nname: ${name}\ndescription: ${description}\n---\nHandle the delegated task and report the result.\n`,
        { mode: 0o600 },
      ),
    { discard: true },
  );
```

Also replace its parent fixture before running the Subagents suite:

```ts
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
```

Keep the existing integration tasks explicitly assigned to `alpha`, `beta`, or `gamma`; Task 2 adds the new omitted-agent boundary case.

- [ ] **Step 7: Run the complete subagent unit suite and formatting**

Run:

```bash
bun --bun vitest run src/subagents --reporter dot
bun typecheck
bunx prettier --check src/subagents
```

Expected: every Subagents unit test PASS, TypeScript PASS, and Prettier reports no changes needed.

- [ ] **Step 8: Commit the complete runtime and unit-test slice**

```bash
git add src/subagents
git commit -m "feat(subagents): inherit active tools through general agent"
```

---

### Task 2: Prove the Real-Process Boundary and Update the Living Contract

**Files:**

- Create: `test/fixtures/inherited-tool-provider.ts`
- Modify: `test/fixtures/fake-pi.ts:7-125,147-191`
- Modify: `src/subagents/subagents.integration.test.ts:1-170,557-723`
- Modify: `docs/specs/subagents.md:1-58,77-85`

**Interfaces:**

- Consumes: exact child argv, frozen manifests, builtin prompt composition, batch diagnostics, and private real-process harness from Task 1.
- Produces: credential-free evidence that one active file-backed provider is selected, unsupported active tools are omitted diagnostically, `subagent` is absent, `complete_subagent` appears once, omitted input resolves to builtin `general`, and the remaining child completes successfully.
- Evidence boundary: this repository test proves preflight, persistence, and exact process composition. Pi 0.80.7 owns runtime enforcement of explicit `--tools`; the plan does not claim the fake executable loaded Pi's model loop.

- [ ] **Step 1: Add the reloadable multi-tool provider fixture**

Create `test/fixtures/inherited-tool-provider.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Parameters = Type.Object({}, { additionalProperties: false });

const register = (pi: ExtensionAPI, name: string): void => {
  pi.registerTool({
    name,
    label: name,
    description: `Fixture tool ${name}`,
    parameters: Parameters,
    async execute() {
      return {
        content: [{ type: "text" as const, text: `${name} executed` }],
        details: { name },
      };
    },
  });
};

export default function inheritedToolProvider(pi: ExtensionAPI): void {
  register(pi, "inherited_probe");
  register(pi, "provider_extra");
  register(pi, "subagent");
}
```

The shared provider deliberately registers unrelated `provider_extra` and nested `subagent`; the exact child allowlist must activate neither.

- [ ] **Step 2: Make the fake process reject unsafe or implicit tool composition**

In `test/fixtures/fake-pi.ts`, parse single-value and repeated options before reading the task file:

```ts
const optionValues = (name: string): ReadonlyArray<string> =>
  args.flatMap((argument, index) =>
    argument === name && args[index + 1] !== undefined
      ? [args[index + 1] as string]
      : [],
  );

const toolOptions = optionValues("--tools");
if (toolOptions.length !== 1) {
  rejectInvocation(
    "tools-option-count",
    `expected exactly one --tools, received ${toolOptions.length}`,
  );
}
const activeToolNames = requireValue(
  toolOptions[0],
  "tools-option-value",
  "--tools requires one value",
).split(",");
if (
  activeToolNames.filter((name) => name === "complete_subagent").length !== 1
) {
  rejectInvocation(
    "completion-tool-count",
    "complete_subagent must appear exactly once",
  );
}
if (activeToolNames.includes("subagent")) {
  rejectInvocation("nested-subagent-active", "subagent must be inactive");
}
if (!args.includes("--no-extensions")) {
  rejectInvocation(
    "normal-extension-discovery",
    "--no-extensions must disable normal discovery",
  );
}
const extensionPaths = optionValues("--extension");
```

Import the production literal and add it to the allowed role prompts:

```ts
import { GENERAL_AGENT_ROLE_PROMPT } from "../../src/subagents/general-agent";

const allowedRolePrompts = [
  "Handle the delegated task and report the result.",
  GENERAL_AGENT_ROLE_PROMPT,
];
```

Include these scalar fields in the existing `validation` observation:

```ts
toolNames: activeToolNames.join(","),
extensionPaths: extensionPaths.join(","),
completionToolCount: activeToolNames.filter(
  (name) => name === "complete_subagent",
).length,
subagentActive: activeToolNames.includes("subagent"),
normalExtensionsDisabled: args.includes("--no-extensions"),
```

Extend the `observe` extra-value union to include these strings/numbers/booleans; do not record task content or tool arguments.

- [ ] **Step 3: Add the failing omitted-general/external/unsupported integration test**

In `src/subagents/subagents.integration.test.ts`, define the fixture path:

```ts
const inheritedToolProviderPath = fileURLToPath(
  new URL("../../test/fixtures/inherited-tool-provider.ts", import.meta.url),
);
```

The existing Markdown definitions and normal parent fixture already use the final no-allowlist and active/all snapshot contracts from Task 1. Add this integration case:

```ts
it.effect(
  "runs builtin general with a reloadable active tool and diagnostic omissions",
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
            "sdk_bound",
            "subagent",
            "complete_subagent",
          ],
          effectiveToolNames: ["read", "inherited_probe", "complete_subagent"],
          providerExtensions: [inheritedToolProviderPath],
          diagnostics: [expect.stringContaining("sdk_bound")],
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
```

- [ ] **Step 4: Run the integration test to verify RED**

Run:

```bash
bun --bun vitest run \
  src/subagents/subagents.integration.test.ts \
  --reporter dot
```

Expected: FAIL before fixture/process updates because definitions still use removed allowlists, omitted `agent`/builtin prompt are not accepted end to end, the fake process does not report tool/extension composition, or the manifest lacks inheritance evidence.

- [ ] **Step 5: Complete fixture and integration updates**

Apply the exact fixture/process changes from Steps 1–2. Existing integration definitions already use the final four-field global contract from Task 1; keep their explicit `alpha`/`beta`/`gamma` requests and existing launch rollback, cancellation, process cleanup, structured completion, private modes, output draining, raw JSONL, stderr, and ordered-outcome assertions unchanged. The fake process now rejects any existing child command that omits the explicit list, activates `subagent`, duplicates completion, or enables normal extension discovery.

- [ ] **Step 6: Replace obsolete living-spec sections**

In `docs/specs/subagents.md`, update the affected contract with this content, integrating it into the existing headings rather than duplicating adjacent lifecycle text:

```md
## Purpose and Surface

The Subagents extension runs small, isolated batches of fresh Pi child processes while preserving bounded concurrency, private durable evidence, and structured outcomes. In a normal parent environment its package entrypoint registers only the sequential `subagent` tool; when `PI_SUBAGENT_CHILD=1`, it registers only `complete_subagent`.

A parent request contains one to three tasks. Each task has a required non-empty instruction, an optional existing working directory, and an optional agent name that defaults to the always-available builtin `general`. Complete preflight still occurs before any run artifact or process is created, and results preserve request order.

## Agent Catalog

Every invocation begins with an embedded `general` definition for arbitrary isolated work, then rediscovers optional user-global Markdown definitions from `<agent-dir>/subagents/agents/`. A valid unique global definition shadows a builtin of the same name. Invalid or duplicate global `general` candidates remain diagnostic while the builtin fallback stays selectable; discovery failures likewise do not prevent builtin selection. Explicit specialized names retain the existing missing, unavailable, indeterminate, and named-invalid failures.

Global frontmatter supports `name`, `description`, optional `model`, and optional `thinking`. Tool capability is not definition configuration. Unknown fields, including the removed `tools` field, invalidate a global definition. The resolved source is `builtin` or `global`, and only a global definition has a definition path.

## Parent Tool Inheritance

At invocation start the extension copies the parent's active tool names separately from all configured provider metadata. Preflight resolves one frozen capability plan in active-parent order and shares it across every task. Configured but inactive tools are not inherited, and later parent changes cannot alter an active batch.

`subagent` and any parent `complete_subagent` entry are filtered as reserved policy. Builtins remain available without an extension. Active file-backed tools load through canonical provider paths deduplicated in first-use order. Missing, ambiguous, SDK-bound, synthetic, non-file, or uncanonicalizable providers are omitted with durable diagnostics rather than failing otherwise valid tasks. `complete_subagent` is added exactly once, so a child may run with completion as its only tool.

## Child Invocation and Durable Evidence

Children keep normal extension discovery disabled and load only the completion extension plus providers selected during preflight. Every command passes an explicit `--tools` list containing the frozen effective names. Additional tools registered by a loaded provider remain unavailable unless present in that list, including `subagent`.

The manifest records resolved agent source, a definition path only for global agents, the parent active-name snapshot, effective child names, canonical provider paths, and unsupported-inheritance diagnostics. Progress and final structured details retain those diagnostics separately from child semantic concerns; model-facing text remains limited to ordered child status, summary, and optional report path.
```

Retain the current sections for model/thinking resolution, project trust, process service, completion finality, run status, rollback, cancellation, privacy, and milestone-one boundaries. Remove every remaining statement that an agent definition controls tools or that unsupported inherited tools fail preflight. Update the public inventory note from Pi 0.80.6 to Pi 0.80.7 and state that live duplicate detection is limited to the winning registration exposed by Pi.

- [ ] **Step 7: Run integration, documentation formatting, and the full repository check**

Run:

```bash
bun --bun vitest run \
  src/subagents/subagents.integration.test.ts \
  test/package-manifest.test.ts \
  --reporter dot
bunx prettier --check \
  test/fixtures/inherited-tool-provider.ts \
  test/fixtures/fake-pi.ts \
  src/subagents/subagents.integration.test.ts \
  docs/specs/subagents.md
bun run check
```

Expected: integration and package-manifest tests PASS, formatting PASS, and `bun run check` reports typecheck/lint plus all test files passing.

- [ ] **Step 8: Commit integration evidence and the living spec**

```bash
git add \
  test/fixtures/inherited-tool-provider.ts \
  test/fixtures/fake-pi.ts \
  src/subagents/subagents.integration.test.ts \
  docs/specs/subagents.md
git commit -m "test(subagents): verify inherited tool boundary"
```

---

### Task 3: Verify and Review the Complete Change

**Files:**

- Review: all files changed since `112587a958c14767043e19fa606367a8addc0b7c`
- Review: `docs/superpowers/specs/2026-07-15-general-subagent-tool-inheritance-design.md`
- Review: `docs/specs/subagents.md`

**Interfaces:**

- Consumes: committed Tasks 1–2.
- Produces: evidence that every approved requirement is implemented, the complete repository is green, the living spec matches, and no unrelated package/process behavior changed.

- [ ] **Step 1: Run focused feature validation from a clean worktree**

Run:

```bash
git status --short
bun --bun vitest run \
  src/subagents/agents.test.ts \
  src/subagents/schemas.test.ts \
  src/subagents/tool-inheritance.test.ts \
  src/subagents/preflight.test.ts \
  src/subagents/index.test.ts \
  src/subagents/child-command.test.ts \
  src/subagents/run-store.test.ts \
  src/subagents/batch.test.ts \
  src/subagents/render.test.ts \
  src/subagents/run-executor.test.ts \
  src/subagents/subagents.integration.test.ts \
  --reporter dot
```

Expected: `git status --short` is empty and every selected file passes.

- [ ] **Step 2: Run repository-wide verification**

Run:

```bash
bun run check
bunx prettier --check \
  src/subagents \
  test/fixtures/fake-pi.ts \
  test/fixtures/inherited-tool-provider.ts \
  docs/specs/subagents.md
git diff --check 112587a958c14767043e19fa606367a8addc0b7c..HEAD
```

Expected: typecheck, lint, all tests, formatting, and whitespace validation PASS.

- [ ] **Step 3: Audit the targeted diff against every approved requirement**

Run:

```bash
git diff --stat 112587a958c14767043e19fa606367a8addc0b7c..HEAD
git diff --name-only 112587a958c14767043e19fa606367a8addc0b7c..HEAD
git diff 112587a958c14767043e19fa606367a8addc0b7c..HEAD -- \
  src/subagents \
  test/fixtures \
  docs/specs/subagents.md
```

Confirm from the diff, not from memory:

1. `general` is embedded with the exact approved identity/prompt and survives missing, unreadable, malformed, and duplicate global discovery.
2. Only a valid uncontested global `general` shadows the builtin; specialized lookup failures remain intact.
3. Both TypeBox and Effect Schema accept omitted `agent`, normalize it before planning, and every visible/durable result says `general`.
4. Global definition `tools` is rejected with no migration path.
5. Active names and all provider metadata are copied separately before runtime execution; inactive configured tools are absent.
6. One tool plan is resolved in active order, shared/frozen, reserved-filtered, provider-deduplicated, best-effort diagnostic, and completion-capable.
7. Every child gets `--no-extensions`, only required explicit providers, and one exact `--tools` value; `subagent` cannot become active through a multi-tool provider.
8. Manifest source/path/tool evidence and expanded invocation diagnostics are complete while model-facing output remains bounded and unchanged.
9. Model/thinking, batch ordering/concurrency, launch barrier, rollback, cancellation, completion finality, private artifacts, and process cleanup remain unchanged.
10. `docs/specs/subagents.md` accurately describes the resulting behavior without implementation detail; no other living spec needs modification.

- [ ] **Step 4: Review the complete branch against `main` as required by repository policy**

Run:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
git status --short --branch
```

Map every changed domain in the full branch to `docs/specs/index.md`. Confirm `docs/specs/subagents.md`, `docs/specs/file-system-service.md`, `docs/specs/process-service.md`, `docs/specs/test-services.md`, `docs/specs/extensions.md`, and `docs/specs/architecture.md` still cover the branch's existing implementation plus this feature. Expected: no untracked/staged files, and this feature requires only the already committed `docs/specs/subagents.md` update.

- [ ] **Step 5: Request an independent code review**

Use `superpowers:requesting-code-review` with this review contract:

```text
Review 112587a958c14767043e19fa606367a8addc0b7c..HEAD against
`docs/superpowers/specs/2026-07-15-general-subagent-tool-inheritance-design.md`.
Check catalog precedence/fallback, optional-agent normalization, active-vs-all
snapshot semantics, best-effort provider resolution, exact child argv, durable
evidence, diagnostic separation, integration strength, and regressions in the
existing batch/process/completion contracts. Report only evidence-backed
findings with file and line references; do not modify files.
```

Expected: no unresolved blocker or correctness finding. If review finds a defect, keep the task open, add a failing regression test, apply the smallest fix, rerun Steps 1–4, and commit the fix with a focused message before completion.
