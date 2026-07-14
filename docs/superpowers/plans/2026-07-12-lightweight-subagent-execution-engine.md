# Lightweight Subagent Execution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build milestone 1 of a repository-native Pi `subagent` extension that safely runs one to three fresh child Pi processes with structured completion, live bounded progress, ordered results, private durable artifacts, and scoped cancellation.

**Architecture:** Keep `src/subagents/index.ts` as the only Pi entrypoint and switch between the parent `subagent` tool and child-only `complete_subagent` tool with `PI_SUBAGENT_CHILD=1`. The parent adapter snapshots Pi context and delegates to Effect-based discovery, preflight, run storage, execution, and batch services; `RunExecutor` owns shell-free child processes and JSON event decoding without depending on the parent TUI. Shared filesystem/process/runtime services provide private atomic storage, launch acknowledgement, and cancellation-safe cleanup.

**Tech Stack:** Bun 1.3.14, TypeScript 6, Effect 3.21, Effect Schema, TypeBox 1.1, Pi extension/JSON CLI APIs 0.80.6, Vitest 4.1, `@effect/vitest`.

## Global Constraints

- Milestone 1 exposes one parent-facing `subagent` tool accepting a required array of one to three tasks; it does not add chains, management actions, tmux, scheduling, worktrees, automatic merging, pruning, commands, or nested delegation.
- Definitions are rediscovered on every invocation from `<agent-dir>/subagents/agents/*.md`; project-local definitions are not supported.
- Every valid one-to-three-task batch may run concurrently; tool allowlists affect child availability and provider loading only, never scheduling eligibility.
- Children start with extension discovery disabled and explicitly load only `src/subagents/index.ts` plus provider extensions required by declared external tools.
- Child argv is always an argument array; task contents travel through `@<absolute-task.md>` and never appear directly in the process list.
- The child environment preserves the inherited environment and adds exactly `PI_SUBAGENT_CHILD=1`.
- Run directories use mode `0700`; artifact files use mode `0600`; runs remain until manually deleted.
- Normal status transitions are monotonic: `STARTING -> RUNNING -> terminal`, where terminal is `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`, `FAILED`, or `ABORTED`. The sole direct `STARTING -> FAILED` transition is reserved for setup/partial-launch rollback so every created run retains an authoritative infrastructure failure.
- A semantic completion is accepted only when `complete_subagent` is the sole final successful tool call and the process exits successfully; later work, malformed output, a bad report, or process/store failure produces `FAILED`.
- Parent cancellation or shutdown records `ABORTED` when no terminal status has already committed and relies on the shared bounded EOF/SIGTERM/SIGKILL cleanup policy.
- Use TypeBox only at Pi tool boundaries and Effect Schema for domain/frontmatter/manifest/event/completion/status decoding.
- Use Bun for dependency and validation commands, keep `.context/` read-only, avoid unsafe assertions/non-null assertions, and update owning living specifications with every changed behavior or service contract.
- Pi 0.80.6 exposes only the winning tool registration through `pi.getAllTools()`. Core provenance resolution must reject duplicate entries when supplied and non-loadable winners, while the adapter must not claim visibility into registrations Pi has already collapsed.
- Do not force project trust in child argv. Context files remain discoverable; project skills follow Pi's saved non-interactive trust policy for each child cwd.

---

## File and Responsibility Map

### Shared infrastructure

- Modify `src/services/file-system.ts` — add generic typed directory, metadata, private write/append, realpath, rename, and remove capabilities.
- Modify `src/services/file-system.test.ts` — verify live metadata, permissions, append, atomic rename, and removal.
- Modify `test/services/file-system.ts` and `test/services/file-system.test.ts` — extend the dual-tag fake and immutable snapshots for every new operation.
- Modify `src/services/process.ts` and `src/services/process.test.ts` — expose replayable launch acknowledgement without changing bounded cleanup.
- Modify `test/services/process.ts` and `test/services/process.test.ts` — support multiple indexed concurrent children and launch failures.
- Modify `src/lib/effect-runtime.ts` and `src/lib/effect-runtime.test.ts` — forward an optional `AbortSignal` into `ManagedRuntime.runPromise`.
- Modify `test/services/index.ts` — export expanded fake configuration and state types.

### Subagent vertical slice

- Create `src/subagents/errors.ts` — tagged errors and one boundary formatter.
- Create `src/subagents/schemas.ts` and `src/subagents/schemas.test.ts` — Effect Schema domain contracts and strict decoding tests.
- Create `src/subagents/agents.ts` and `src/subagents/agents.test.ts` — definition discovery and duplicate exclusion.
- Create `src/subagents/preflight.ts` and `src/subagents/preflight.test.ts` — cwd/model/thinking/tool resolution, provider provenance, and frozen execution plans.
- Create `src/subagents/run-store.ts` and `src/subagents/run-store.test.ts` — private artifacts, raw stream appends, atomic status transitions, and terminal immutability.
- Create `src/subagents/completion.ts` and `src/subagents/completion.test.ts` — child completion validation and terminating tool result.
- Create `src/subagents/pi-events.ts` and `src/subagents/pi-events.test.ts` — JSON line decoding, usage aggregation, and completion-finality state machine.
- Create `src/subagents/progress.ts` and `src/subagents/progress.test.ts` — bounded per-child previews and ordered progress snapshots.
- Create `src/subagents/child-command.ts` and `src/subagents/child-command.test.ts` — Pi executable selection and exact shell-free argv/environment construction.
- Create `src/subagents/run-executor.ts` and `src/subagents/run-executor.test.ts` — host-independent scoped launch/stream/wait/finalize behavior.
- Create `src/subagents/batch.ts` and `src/subagents/batch.test.ts` — all-or-nothing setup/launch barrier, rollback, sibling independence, cancellation, and ordered results.
- Create `src/subagents/render.ts` and `src/subagents/render.test.ts` — concise model-facing results and bounded TUI components.
- Create `src/subagents/index.ts` and `src/subagents/index.test.ts` — sole Pi registration/composition adapter.
- Create `test/fixtures/fake-pi.ts` and `src/subagents/subagents.integration.test.ts` — credential-free real-process streaming scenarios.

### Package and living contracts

- Modify `package.json`, `bun.lock`, and `test/package-manifest.test.ts` — add the one entrypoint and direct runtime dependencies.
- Create `docs/specs/subagents.md` — own milestone-1 behavior and architecture.
- Create `docs/specs/file-system-service.md` — own the expanded generic filesystem contract.
- Modify `docs/specs/index.md`, `docs/specs/extensions.md`, `docs/specs/process-service.md`, and `docs/specs/test-services.md` — index and cross-reference changed contracts.

## Frozen Interfaces Between Tasks

These names are the handoff contract for later tasks:

```ts
export type SemanticStatus =
  "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";
export type TerminalStatus = SemanticStatus | "FAILED" | "ABORTED";
export type RunStatus = "STARTING" | "RUNNING" | TerminalStatus;

export interface ResolvedAgent {
  readonly name: string;
  readonly description: string;
  readonly rolePrompt: string;
  readonly model: string;
  readonly thinking:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly tools?: ReadonlyArray<string>;
  readonly providerExtensions: ReadonlyArray<string>;
  readonly definitionPath: string;
}

export interface ResolvedTask {
  readonly index: number;
  readonly task: string;
  readonly cwd: string;
  readonly agent: ResolvedAgent;
}

export interface ModelResolutionPort {
  readonly resolve: (
    pattern: string,
    thinking: ResolvedAgent["thinking"],
  ) => Effect.Effect<
    { readonly model: string; readonly thinking: ResolvedAgent["thinking"] },
    SubagentError
  >;
}

export interface RunArtifacts {
  readonly runId: string;
  readonly runDirectory: string;
  readonly manifestPath: string;
  readonly taskPath: string;
  readonly systemPromptPath: string;
  readonly eventsPath: string;
  readonly stderrPath: string;
  readonly statusPath: string;
}

export interface CompletionResult {
  readonly status: SemanticStatus;
  readonly summary: string;
  readonly reportPath?: string;
}

export interface RunUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly turns: number;
}

export interface RunResult {
  readonly runId: string;
  readonly agent: string;
  readonly status: TerminalStatus;
  readonly summary: string;
  readonly reportPath?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly usage: RunUsage;
  readonly artifacts: RunArtifacts;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface RunHandle {
  readonly launched: Effect.Effect<void, SubagentError>;
  readonly awaitResult: Effect.Effect<RunResult, SubagentError>;
}

export interface RunExecutor {
  readonly launch: (
    task: ResolvedTask,
    artifacts: RunArtifacts,
    onProgress: (progress: ChildProgress) => Effect.Effect<void>,
  ) => Effect.Effect<RunHandle, SubagentError, Scope.Scope>;
}
```

---

### Task 1: Expand Generic Filesystem Capabilities

**Files:**

- Modify: `src/services/file-system.ts`
- Modify: `src/services/file-system.test.ts`
- Modify: `test/services/file-system.ts`
- Modify: `test/services/file-system.test.ts`
- Modify: `test/services/index.ts`

**Interfaces:**

- Consumes: existing `FileSystemService`, `FileSystemError`, and dual-tag fake conventions.
- Produces: generic operations used by agent discovery, preflight, completion validation, and `RunStore`.

- [ ] **Step 1: Write failing live-service tests for metadata, private files, append, rename, realpath, and removal**

Add tests that exercise this exact public shape:

```ts
const fileSystem = yield * FileSystemService;
const runDirectory = join(directory, "run");
const source = join(runDirectory, "status.next.json");
const target = join(runDirectory, "status.json");

yield *
  fileSystem.makeDirectory(runDirectory, { recursive: true, mode: 0o700 });
yield *
  fileSystem.writeTextFile(source, '{"status":"STARTING"}\n', { mode: 0o600 });
yield * fileSystem.appendTextFile(source, "tail\n");
yield * fileSystem.rename(source, target);

expect(yield * fileSystem.readTextFile(target)).toBe(
  '{"status":"STARTING"}\ntail\n',
);
expect((yield * fileSystem.stat(runDirectory)).kind).toBe("directory");
expect((yield * fileSystem.stat(target)).kind).toBe("file");
expect((yield * fileSystem.stat(runDirectory)).mode & 0o777).toBe(0o700);
expect((yield * fileSystem.stat(target)).mode & 0o777).toBe(0o600);
expect(yield * fileSystem.realPath(target)).toBe(target);

yield * fileSystem.remove(target);
expect(yield * fileSystem.exists(target)).toBe(false);
```

Also test `readDirectory` returns names plus `file | directory | other`, `stat` rejects missing paths through `FileSystemError`, and `remove` supports `{ recursive: true }` only when requested.

- [ ] **Step 2: Run the live-service tests and verify RED**

Run:

```bash
bun --bun vitest run src/services/file-system.test.ts --reporter dot
```

Expected: FAIL with missing `makeDirectory`, `writeTextFile`, `appendTextFile`, `rename`, `stat`, `realPath`, `readDirectory`, and `remove` members.

- [ ] **Step 3: Extend the service contract and live layer**

Implement these exact additions while preserving the existing methods:

```ts
export type FileSystemOperation =
  | "exists"
  | "statMtimeMs"
  | "stat"
  | "readDirectory"
  | "readTextFile"
  | "makeDirectory"
  | "writeTextFile"
  | "appendTextFile"
  | "realPath"
  | "rename"
  | "remove";

export interface FileMetadata {
  readonly kind: "file" | "directory" | "other";
  readonly mtimeMs: number;
  readonly mode: number;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
}

export interface FileSystemService {
  readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>;
  readonly statMtimeMs: (
    path: string,
  ) => Effect.Effect<number, FileSystemError>;
  readonly stat: (path: string) => Effect.Effect<FileMetadata, FileSystemError>;
  readonly readDirectory: (
    path: string,
  ) => Effect.Effect<ReadonlyArray<DirectoryEntry>, FileSystemError>;
  readonly readTextFile: (
    path: string,
  ) => Effect.Effect<string, FileSystemError>;
  readonly makeDirectory: (
    path: string,
    options: { readonly recursive: boolean; readonly mode: number },
  ) => Effect.Effect<void, FileSystemError>;
  readonly writeTextFile: (
    path: string,
    content: string,
    options: { readonly mode: number },
  ) => Effect.Effect<void, FileSystemError>;
  readonly appendTextFile: (
    path: string,
    content: string,
  ) => Effect.Effect<void, FileSystemError>;
  readonly realPath: (path: string) => Effect.Effect<string, FileSystemError>;
  readonly rename: (
    from: string,
    to: string,
  ) => Effect.Effect<void, FileSystemError>;
  readonly remove: (
    path: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<void, FileSystemError>;
}
```

Use `node:fs/promises` argument-array APIs only. Map `Dirent` and `Stats` without exposing Node objects, copy arrays before returning, and keep every failure tagged with operation and path; for rename errors use `path: `${from} -> ${to}``.

- [ ] **Step 4: Write failing fake-service tests**

Configure and assert calls without touching disk:

```ts
const layer = FileSystemServiceTest.layer({
  directories: new Map([["/agents", [{ name: "alpha.md", kind: "file" }]]]),
  metadata: new Map([
    ["/agents", { kind: "directory", mtimeMs: 1, mode: 0o700 }],
  ]),
  realPaths: new Map([["/agents", "/real/agents"]]),
});

const fileSystem = yield * FileSystemService;
const controls = yield * FileSystemServiceTest;
expect(yield * fileSystem.readDirectory("/agents")).toEqual([
  { name: "alpha.md", kind: "file" },
]);
yield * fileSystem.writeTextFile("/runs/status.json", "{}\n", { mode: 0o600 });
yield * fileSystem.rename("/runs/status.json", "/runs/status.old.json");
expect((yield * controls.getState).calls).toContainEqual({
  operation: "writeTextFile",
  path: "/runs/status.json",
  content: "{}\n",
  mode: 0o600,
});
```

Require copied snapshots and add controls `setDirectory`, `setMetadata`, `setRealPath`, and `setContent`; mutation operations update fake state so later reads observe writes, appends, renames, and removes.

- [ ] **Step 5: Run fake tests and verify RED**

Run:

```bash
bun --bun vitest run test/services/file-system.test.ts --reporter dot
```

Expected: FAIL because the fake configuration, controls, calls, and mutation semantics are absent.

- [ ] **Step 6: Implement and export the expanded fake**

Keep unconfigured reads as defects, configured `FileSystemError` values as typed failures, and snapshot copies as independent `Map`/array/object values. Export all new fake types from `test/services/index.ts`.

- [ ] **Step 7: Run focused filesystem tests**

Run:

```bash
bun --bun vitest run src/services/file-system.test.ts test/services/file-system.test.ts --reporter dot
```

Expected: PASS.

- [ ] **Step 8: Commit the filesystem capability**

```bash
git add src/services/file-system.ts src/services/file-system.test.ts test/services/file-system.ts test/services/file-system.test.ts test/services/index.ts
git commit -m "feat(services): expand filesystem capabilities"
```

---

### Task 2: Add Launch Acknowledgement and Abort-Aware Effect Execution

**Files:**

- Modify: `src/services/process.ts`
- Modify: `src/services/process.test.ts`
- Modify: `test/services/process.ts`
- Modify: `test/services/process.test.ts`
- Modify: `src/lib/effect-runtime.ts`
- Modify: `src/lib/effect-runtime.test.ts`
- Modify: `test/services/index.ts`

**Interfaces:**

- Consumes: existing `ProcessService.spawnScoped`, bounded `ManagedProcess.shutdown`, and `makeEffectRunner`.
- Produces: replayable `ManagedProcess.awaitLaunch`, indexed concurrent process controls, and `runPromise(effect, { signal })`.

- [ ] **Step 1: Write failing production tests for launch acknowledgement**

Add one successful spawn test and one immediate spawn-error test:

```ts
const managed =
  yield * processes.spawnScoped("fake", [], { stdio: "pipe" }, shutdownPolicy);
yield * managed.awaitLaunch;
expect(spawnOverride).toHaveBeenCalledOnce();
```

For the error case, emit `error` before `spawn` and assert both `awaitLaunch` and `waitForExit` replay the same `ProcessError` with operation `spawn`.

- [ ] **Step 2: Expose the existing launch deferred**

Add to the interface and returned object:

```ts
export interface ManagedProcess extends SpawnedProcess {
  readonly awaitLaunch: Effect.Effect<void, ProcessError>;
  readonly requestStdinEnd: Effect.Effect<void, ProcessError>;
  readonly awaitStdinEnd: Effect.Effect<void, ProcessError>;
  readonly shutdown: Effect.Effect<ProcessShutdownReport>;
}
```

Use the existing `SpawnedProcessLaunch.awaitLaunch`; do not create a second launch listener or change cleanup timing.

- [ ] **Step 3: Write failing concurrent fake tests**

Exercise two children by index:

```ts
const first =
  yield * processes.spawnScoped("pi", ["first"], options, shutdownPolicy);
const second =
  yield * processes.spawnScoped("pi", ["second"], options, shutdownPolicy);
yield * controls.emitLaunch(0);
yield * controls.emitLaunch(1);
yield * controls.emitStdout(1, "second-line");
yield * controls.emitExit(0, { code: 0, signal: null });
yield * controls.emitExit(1, { code: 0, signal: null });
expect(yield * Stream.runCollect(second.stdoutLines)).toEqual(
  Chunk.of("second-line"),
);
expect((yield * controls.getState).processes).toHaveLength(2);
```

Also assert `emitLaunchFailure(index, error)`, indexed stderr, indexed signals, and copied per-process snapshots.

- [ ] **Step 4: Implement indexed process fake controls**

Replace the single `active` process with an ordered `processes` array. Expose this control surface:

```ts
export interface ProcessServiceTestService {
  readonly emitLaunch: (index: number) => Effect.Effect<void>;
  readonly emitLaunchFailure: (
    index: number,
    error: ProcessError,
  ) => Effect.Effect<void>;
  readonly emitStdout: (index: number, line: string) => Effect.Effect<void>;
  readonly emitStderr: (index: number, chunk: string) => Effect.Effect<void>;
  readonly emitExit: (index: number, exit: ProcessExit) => Effect.Effect<void>;
  readonly emitError: (
    index: number,
    error: ProcessError,
  ) => Effect.Effect<void>;
  readonly getState: Effect.Effect<ProcessServiceTestState>;
  readonly resetCalls: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}
```

Preserve convenience by auto-confirming launch unless `ProcessServiceTestConfig.manualLaunch === true`; existing tests should not need timing changes.

- [ ] **Step 5: Write failing abort propagation test for `makeEffectRunner`**

Use a scoped finalizer:

```ts
const controller = new AbortController();
let finalized = false;
const promise = runner.runPromise(
  Effect.acquireUseRelease(
    Effect.void,
    () => Effect.never,
    () =>
      Effect.sync(() => {
        finalized = true;
      }),
  ),
  { signal: controller.signal },
);
controller.abort();
await expect(promise).rejects.toBeDefined();
expect(finalized).toBe(true);
```

- [ ] **Step 6: Forward the signal through the runtime adapter**

Implement:

```ts
runPromise: <A, E2>(
  effect: Effect.Effect<A, E2, R>,
  options?: { readonly signal?: AbortSignal },
): Promise<A> => runtime.runPromise(effect, options),
```

Keep disposal idempotent.

- [ ] **Step 7: Run focused process/runtime tests**

Run:

```bash
bun --bun vitest run src/services/process.test.ts test/services/process.test.ts src/lib/effect-runtime.test.ts --reporter dot
```

Expected: PASS.

- [ ] **Step 8: Commit process/runtime support**

```bash
git add src/services/process.ts src/services/process.test.ts test/services/process.ts test/services/process.test.ts src/lib/effect-runtime.ts src/lib/effect-runtime.test.ts test/services/index.ts
git commit -m "feat(services): expose child launch lifecycle"
```

---

### Task 3: Define Strict Domain Schemas and Tagged Errors

**Files:**

- Create: `src/subagents/errors.ts`
- Create: `src/subagents/schemas.ts`
- Create: `src/subagents/schemas.test.ts`

**Interfaces:**

- Consumes: Effect `Schema`, `Data.TaggedError`, and the frozen interfaces above.
- Produces: decoded requests, definitions, manifests, statuses, completions, results, and errors used by all remaining tasks.

- [ ] **Step 1: Write schema boundary tests**

Cover one/three accepted tasks, zero/four rejected tasks, whitespace-only task/agent, multiline names/descriptions, unknown frontmatter keys, invalid `thinking`, excess-property `writer`, duplicate/empty tools, completion summary length 1/500/501, relative report paths, valid status records, and malformed manifest/status JSON.

Use exact examples:

```ts
expect(
  decodeTasks({ tasks: [{ agent: " alpha ", task: " inspect " }] }),
).toEqual({
  tasks: [{ agent: "alpha", task: "inspect" }],
});
expect(() => decodeTasks({ tasks: [] })).toThrow();
expect(() =>
  decodeCompletion({ status: "DONE", summary: "x".repeat(501) }),
).toThrow();
expect(() =>
  decodeAgentFrontmatter({ name: "alpha\nbeta", description: "bad" }),
).toThrow();
```

- [ ] **Step 2: Run schema tests and verify RED**

Run:

```bash
bun --bun vitest run src/subagents/schemas.test.ts --reporter dot
```

Expected: FAIL because the schema module does not exist.

- [ ] **Step 3: Implement schemas and exported decoders**

Define exact public discriminants:

```ts
export const SemanticStatusSchema = Schema.Literal(
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
);
export const TerminalStatusSchema = Schema.Union(
  SemanticStatusSchema,
  Schema.Literal("FAILED", "ABORTED"),
);
export const RunStatusSchema = Schema.Union(
  Schema.Literal("STARTING", "RUNNING"),
  TerminalStatusSchema,
);
export const ThinkingLevelSchema = Schema.Literal(
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
);
```

Use strict `Schema.Struct` decoding for frontmatter keys `name`, `description`, `model`, `thinking`, and `tools`; transform trimmed single-line strings and comma-separated tools into immutable arrays. Keep `tools` absent distinct from an empty list, reject duplicate names in one allowlist, and require an excess-property test for `writer`.

Define minimal JSON schemas for `RunManifest`, `RunStatusRecord`, `CompletionResult`, `RunUsage`, `RunResult`, and `SubagentToolDetails`; every persisted timestamp is an ISO string produced at the boundary, and every optional property stays optional rather than using unsafe casts.

- [ ] **Step 4: Implement tagged errors and one boundary formatter**

Create these tags with structured fields rather than preformatted stacks:

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

Each class extends `Data.TaggedError`; `formatSubagentError(error)` is the only model-facing formatter and includes the tag, primary subject, and concise message once.

- [ ] **Step 5: Run schema tests**

Run:

```bash
bun --bun vitest run src/subagents/schemas.test.ts --reporter dot
```

Expected: PASS.

- [ ] **Step 6: Commit the domain contract**

```bash
git add src/subagents/errors.ts src/subagents/schemas.ts src/subagents/schemas.test.ts
git commit -m "feat(subagents): define execution domain schemas"
```

---

### Task 4: Discover Agents and Perform Complete Preflight

**Files:**

- Create: `src/subagents/agents.ts`
- Create: `src/subagents/agents.test.ts`
- Create: `src/subagents/preflight.ts`
- Create: `src/subagents/preflight.test.ts`

**Interfaces:**

- Consumes: `resolveAgentDirectoryEffect`, expanded `FileSystemService`, `parseFrontmatter`, request/frontmatter schemas, and Pi-derived parent/tool DTOs.
- Produces: ordered `ReadonlyArray<ResolvedTask>` with every mutable parent/definition value frozen before artifacts exist.

- [ ] **Step 1: Write failing discovery tests**

Verify only direct `*.md` regular files under `<agent-dir>/subagents/agents` are considered; malformed YAML/schema/body files are diagnosed and excluded without blocking a valid neighbor; all definitions sharing a duplicate `name` are excluded; files are reread on a second call.

Use this result contract:

```ts
export interface AgentDiscovery {
  readonly definitions: ReadonlyArray<DiscoveredAgent>;
  readonly diagnostics: ReadonlyArray<AgentDefinitionDiagnostic>;
}

export const discoverAgents: Effect.Effect<
  AgentDiscovery,
  never,
  FileSystemService | EnvironmentService | HomeDirectoryService
>;
```

A missing definitions directory returns empty arrays; an unreadable existing directory records a diagnostic rather than dying.

- [ ] **Step 2: Run discovery tests and verify RED**

Run:

```bash
bun --bun vitest run src/subagents/agents.test.ts --reporter dot
```

Expected: FAIL because `discoverAgents` is absent.

- [ ] **Step 3: Implement discovery**

Use `resolveAgentDirectoryEffect`, `readDirectory`, `readTextFile`, Pi's exported `parseFrontmatter<Record<string, unknown>>()`, and the strict Effect decoder. Preserve only the supported fields, keep omitted model/thinking/tools available for preflight inheritance, and retain the absolute definition path without defaulting a classification.

- [ ] **Step 4: Write failing preflight tests**

Define adapter DTOs:

```ts
export interface ParentSnapshot {
  readonly cwd: string;
  readonly model?: string;
  readonly thinking: ThinkingLevel;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    readonly path: string;
    readonly baseDir?: string;
  }>;
}

export interface PreflightInput {
  readonly request: SubagentRequest;
  readonly discovery: AgentDiscovery;
  readonly parent: ParentSnapshot;
  readonly models: ModelResolutionPort;
}
```

Test relative `cwd` resolves against `parent.cwd`; absolute cwd stays absolute; both must be existing directories. Test missing agent, malformed-only agent, omitted parent model, model/thinking inheritance, explicit model-pattern resolution, resolver warnings/errors, omitted and mutation-capable allowlists, unknown/custom/bash tools, missing/SDK/synthetic/duplicate provider entries, non-file provider paths, provider path deduplication, reserved `complete_subagent`, reserved `subagent`, and three accepted tasks in stable request order.

- [ ] **Step 5: Run preflight tests and verify RED**

Run:

```bash
bun --bun vitest run src/subagents/preflight.test.ts --reporter dot
```

Expected: FAIL because preflight behavior is absent.

- [ ] **Step 6: Implement provider-only tool resolution**

Use declared tool allowlists as execution configuration only. Reject reserved `complete_subagent` and `subagent`, group the provided snapshot by requested name, require one entry per declared tool, accept `source === "builtin"` without an extension, reject `source === "sdk"` and angle-bracket synthetic paths, resolve relative paths against `baseDir` when present and otherwise against parent cwd, require the resulting path to be an existing regular file, and deduplicate canonical real paths in first-use order.

Tool allowlists determine child availability and provider loading; they do not affect scheduling eligibility.

- [ ] **Step 7: Implement full preflight and no-artifact boundary**

Resolve every request item first, freeze the complete resolved array only after every task succeeds, and return only then. For an explicit agent model, call `models.resolve(pattern, definition.thinking ?? parent.thinking)` and freeze its canonical `provider/id` plus resolved/clamped thinking; for an omitted model, require `parent.model` and freeze it with the explicit or inherited thinking level. The function has no `RunStore` dependency, which structurally guarantees preflight cannot create artifacts.

- [ ] **Step 8: Run focused discovery/preflight tests**

Run:

```bash
bun --bun vitest run src/subagents/agents.test.ts src/subagents/preflight.test.ts --reporter dot
```

Expected: PASS.

- [ ] **Step 9: Commit discovery and policy**

```bash
git add src/subagents/agents.ts src/subagents/agents.test.ts src/subagents/preflight.ts src/subagents/preflight.test.ts
git commit -m "feat(subagents): add discovery and preflight policy"
```

---

### Task 5: Build the Private Atomic Run Store

**Files:**

- Create: `src/subagents/run-store.ts`
- Create: `src/subagents/run-store.test.ts`

**Interfaces:**

- Consumes: `ResolvedTask`, `RunArtifacts`, manifest/status schemas, expanded `FileSystemService`, Effect `Clock`, and an injected collision-resistant run-ID factory backed by `node:crypto.randomUUID` in the Live layer.
- Produces: artifact creation, append operations, and serialized monotonic status commits.

- [ ] **Step 1: Write failing run-store tests**

Assert exact files and permissions under `<agent-dir>/subagents/runs/<timestamp>-<uuid>/`, task text only in `task.md`, role/nesting/completion prompt in `system-prompt.md`, frozen execution data in `run.json`, empty logs, and `STARTING` in `status.json`.

Test transitions:

```ts
const run = yield * store.create(resolvedTask);
yield * run.transition({ status: "RUNNING", updatedAt: now });
yield *
  run.transition({ status: "DONE", updatedAt: later, summary: "complete" });
const ignored =
  yield *
  run.transition({ status: "FAILED", updatedAt: latest, summary: "late" });
expect(ignored).toBe(false);
expect((yield * run.readStatus).status).toBe("DONE");
```

Also race `DONE` and `ABORTED` with `Effect.all(..., { concurrency: 2 })` and assert exactly one terminal record wins; reject `STARTING -> DONE`, `RUNNING -> STARTING`, and repeated `RUNNING`. Accept `STARTING -> FAILED` only when the record carries the infrastructure-rollback diagnostic used by Task 8; reject direct semantic or aborted terminals from `STARTING`.

- [ ] **Step 2: Run run-store tests and verify RED**

Run:

```bash
bun --bun vitest run src/subagents/run-store.test.ts --reporter dot
```

Expected: FAIL because `RunStore` is absent.

- [ ] **Step 3: Implement artifact creation**

Expose:

```ts
export interface ActiveRunStore {
  readonly artifacts: RunArtifacts;
  readonly transition: (
    record: RunStatusRecord,
  ) => Effect.Effect<boolean, RunStoreError>;
  readonly readStatus: Effect.Effect<RunStatusRecord, RunStoreError>;
  readonly appendEvent: (rawLine: string) => Effect.Effect<void, RunStoreError>;
  readonly appendStderr: (chunk: string) => Effect.Effect<void, RunStoreError>;
}

export interface RunStore {
  readonly create: (
    task: ResolvedTask,
  ) => Effect.Effect<ActiveRunStore, RunStoreError>;
}
```

Create the directory with `0700`, every file with `0600`, newline-terminate JSON, and write all initial files before returning. If creation fails, retain partial evidence and report the path/error; do not recursively delete the run.

- [ ] **Step 4: Implement atomic serialized status replacement**

Use a per-run Effect semaphore. For each accepted transition, write `status.<uuid>.tmp` with `0600`, then rename it over `status.json`; remove a leftover temp file on rename failure without replacing the primary error. Return `false` for late writes against terminal status so cancellation/exit races remain benign.

- [ ] **Step 5: Run run-store tests**

Run:

```bash
bun --bun vitest run src/subagents/run-store.test.ts --reporter dot
```

Expected: PASS.

- [ ] **Step 6: Commit the run store**

```bash
git add src/subagents/run-store.ts src/subagents/run-store.test.ts
git commit -m "feat(subagents): add durable private run store"
```

---

### Task 6: Implement Structured Completion, Event Decoding, and Progress

**Files:**

- Create: `src/subagents/completion.ts`
- Create: `src/subagents/completion.test.ts`
- Create: `src/subagents/pi-events.ts`
- Create: `src/subagents/pi-events.test.ts`
- Create: `src/subagents/progress.ts`
- Create: `src/subagents/progress.test.ts`

**Interfaces:**

- Consumes: completion/event schemas and `FileSystemService`.
- Produces: child completion tool logic, `PiEventAccumulator`, and bounded `ChildProgress` snapshots for `RunExecutor` and rendering.

- [ ] **Step 1: Write failing completion tests**

Test all four semantic statuses, trimmed one-line summaries, 500-character acceptance, 501-character rejection, relative/missing/directory report rejection, and existing regular absolute report acceptance.

Assert the successful result exactly:

```ts
expect(yield * completeSubagent(input)).toEqual({
  content: [{ type: "text", text: "Subagent completion recorded: DONE" }],
  details: {
    status: "DONE",
    summary: "Implemented parser",
    reportPath: "/tmp/report.md",
  },
  terminate: true,
});
```

Semantic validation failures must fail the Effect so the Pi adapter throws and lets the child model correct its call.

- [ ] **Step 2: Implement completion validation**

Define a local structural `CompletionToolResult` with `content`, `details: CompletionResult`, and `terminate: true`, then export `completeSubagent(input): Effect.Effect<CompletionToolResult, CompletionValidationError, FileSystemService>`. Decode first, then use `stat` and `realPath`; persist the canonical report path in details. This avoids a direct production import from `@earendil-works/pi-agent-core`; Pi's `registerTool` verifies the structural return type at the adapter.

- [ ] **Step 3: Write failing event-state tests**

Feed raw JSON lines for session headers, assistant `message_update` text deltas, tool starts, assistant `message_end` usage, completion `tool_execution_end`, `agent_settled`, unknown objects, malformed non-empty lines, and provider errors with exit code zero.

Use this API:

```ts
const accumulator = makePiEventAccumulator();
const first = yield * accumulator.consume(rawLine);
const snapshot = yield * accumulator.snapshot;
const final = yield * accumulator.finalize({ code: 0, signal: null });
```

Test that a completion candidate is valid only when correlated with an assistant message containing exactly one `complete_subagent` call, its result has `isError: false`, no later assistant/tool work occurs, and the stream settles. Any later work invalidates it permanently.

- [ ] **Step 4: Implement JSON decoding and usage aggregation**

Append raw non-empty lines to `events.jsonl` before decoding in the executor; the accumulator itself returns a typed `PiEventStreamError` on malformed JSON. Decode feature-used shapes with Effect Schema, retain unknown valid JSON as ignored events, and aggregate usage only from assistant `message_end` events:

```ts
usage.input += message.usage.input;
usage.output += message.usage.output;
usage.cacheRead += message.usage.cacheRead;
usage.cacheWrite += message.usage.cacheWrite;
usage.cost += message.usage.cost.total;
usage.turns += 1;
```

Track assistant `stopReason === "error" | "aborted"` as failure even when process exit is zero.

- [ ] **Step 5: Write failing bounded-progress tests**

Define internal constants and assert them:

```ts
export const MAX_PROGRESS_ITEMS = 12;
export const MAX_ASSISTANT_PREVIEW = 240;
export const MAX_TOOL_PREVIEW = 160;
```

A progress snapshot contains run ID, agent, lifecycle, latest bounded items, and aggregate usage; it never contains raw JSON or full tool results.

- [ ] **Step 6: Implement progress projection**

Represent items as `{ type: "assistant"; text } | { type: "tool"; name; preview }`, truncate by Unicode code points, retain only the latest 12, and copy arrays on every snapshot.

- [ ] **Step 7: Run completion/event/progress tests**

Run:

```bash
bun --bun vitest run src/subagents/completion.test.ts src/subagents/pi-events.test.ts src/subagents/progress.test.ts --reporter dot
```

Expected: PASS.

- [ ] **Step 8: Commit structured child output handling**

```bash
git add src/subagents/completion.ts src/subagents/completion.test.ts src/subagents/pi-events.ts src/subagents/pi-events.test.ts src/subagents/progress.ts src/subagents/progress.test.ts
git commit -m "feat(subagents): validate structured child completion"
```

---

### Task 7: Construct Child Commands and Implement `RunExecutor`

**Files:**

- Create: `src/subagents/child-command.ts`
- Create: `src/subagents/child-command.test.ts`
- Create: `src/subagents/run-executor.ts`
- Create: `src/subagents/run-executor.test.ts`

**Interfaces:**

- Consumes: `ProcessService`, `EnvironmentService`, `RunStore`, event/progress modules, and Task 2 launch acknowledgement.
- Produces: shell-free `ChildInvocation` and host-independent `RunExecutor` matching the frozen interface.

- [ ] **Step 1: Write failing command-construction tests**

Assert the exact child argv order:

```ts
expect(buildChildInvocation(input)).toEqual({
  command: process.execPath,
  args: [
    currentPiScript,
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--extension",
    completionEntrypoint,
    "--extension",
    providerEntrypoint,
    "--model",
    "openai-codex/gpt-5.4",
    "--thinking",
    "high",
    "--tools",
    "read,web_search,complete_subagent",
    "--append-system-prompt",
    artifacts.systemPromptPath,
    `@${artifacts.taskPath}`,
  ],
  cwd: resolvedTask.cwd,
  env: { ...parentEnv, PI_SUBAGENT_CHILD: "1" },
});
```

When `agent.tools` is omitted, omit `--tools`; completion remains active because its explicitly loaded extension registers it. Ensure task text and role prompt text are absent from both command and args. Test the pinned Pi selection rule: real `process.argv[1]` script through `process.execPath`, compiled non-generic executable directly, and `pi` fallback for generic Bun/Node without a real script.

- [ ] **Step 2: Implement `ChildInvocation`**

```ts
export interface ChildInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}
```

Canonicalize and deduplicate explicit extension paths before argv construction. Never use `shell`, command strings, or stdin task transport.

- [ ] **Step 3: Write failing executor tests**

With `ProcessServiceTest.layer({ manualLaunch: true })`, prove:

1. `launch()` creates the scoped process and returns a handle before launch confirmation.
2. `handle.launched` waits for `emitLaunch(index)` and then commits `RUNNING`.
3. stdin EOF is requested immediately so Pi cannot wait on piped stdin.
4. stdout/stderr are consumed concurrently and appended to their artifacts.
5. valid completion + code 0 returns the semantic status.
6. code 0 without completion, provider error, malformed JSON, invalidated completion, nonzero code, or signal returns `FAILED`.
7. interruption closes scope, runs bounded shutdown, and commits `ABORTED` unless terminal already won.
8. store failure becomes `FAILED` when recordable and remains an explicit `RunStoreError` diagnostic when not.

- [ ] **Step 4: Run executor tests and verify RED**

Run:

```bash
bun --bun vitest run src/subagents/child-command.test.ts src/subagents/run-executor.test.ts --reporter dot
```

Expected: FAIL because command/executor modules are absent.

- [ ] **Step 5: Implement scoped launch and stream drains**

Use `ProcessService.spawnScoped(..., { stdio: "pipe" }, policy)`. After acquisition, fork stdout and stderr consumers inside the same scope, request stdin EOF, and expose `managed.awaitLaunch` as `RunHandle.launched`. The stdout consumer performs:

```ts
Stream.runForEach(managed.stdoutLines, (line) =>
  runStore.appendEvent(`${line}\n`).pipe(
    Effect.zipRight(accumulator.consume(line)),
    Effect.tap((event) => progress.update(event)),
    Effect.flatMap(() => onProgress(progress.snapshot)),
  ),
);
```

The stderr consumer appends chunks unchanged. Await both consumers and `waitForExit`; interruption must close the process scope before executor finalization returns.

- [ ] **Step 6: Implement terminal commitment**

After confirmed launch, commit `RUNNING`. Finalize the event accumulator with process exit, map valid semantic completion to its status/summary/report, otherwise create `FAILED` with one concise diagnostic, then attempt one terminal transition. Add an `Effect.onInterrupt` finalizer that attempts `ABORTED` and never overwrites terminal status.

- [ ] **Step 7: Run command/executor tests**

Run:

```bash
bun --bun vitest run src/subagents/child-command.test.ts src/subagents/run-executor.test.ts --reporter dot
```

Expected: PASS.

- [ ] **Step 8: Commit the executor**

```bash
git add src/subagents/child-command.ts src/subagents/child-command.test.ts src/subagents/run-executor.ts src/subagents/run-executor.test.ts
git commit -m "feat(subagents): add scoped run executor"
```

---

### Task 8: Add Atomic Batch Orchestration

**Files:**

- Create: `src/subagents/batch.ts`
- Create: `src/subagents/batch.test.ts`

**Interfaces:**

- Consumes: request decoder, discovery/preflight, `RunStore`, `RunExecutor`, and progress snapshots.
- Produces: one Effect program per parent tool call with complete preflight, all-created/all-launched barriers, rollback, independent outcomes, and ordered results.

- [ ] **Step 1: Write failing batch tests**

Use fake discovery/store/executor ports with role-neutral names to cover:

- one child;
- three unrestricted tasks with observed overlap;
- mixed allowlists, including mutation-capable tools;
- completion order `2, 0, 1` returning request order `0, 1, 2`;
- mixed `DONE`, `BLOCKED`, and `FAILED` after all launch;
- artifact failure after one run creation;
- launch failure after one child confirms launch;
- sibling independence after the launch barrier;
- cancellation producing `ABORTED` for all nonterminal runs.

Assert preflight errors cause zero `create` and zero `launch` calls.

- [ ] **Step 2: Define the batch port and run API**

```ts
export interface BatchProgress {
  readonly children: ReadonlyArray<ChildProgress>;
}

export interface SubagentBatch {
  readonly execute: (
    request: unknown,
    parent: ParentSnapshot,
    onProgress: (progress: BatchProgress) => Effect.Effect<void>,
  ) => Effect.Effect<ReadonlyArray<RunResult>, SubagentError>;
}
```

- [ ] **Step 3: Run batch tests and verify RED**

Run:

```bash
bun --bun vitest run src/subagents/batch.test.ts --reporter dot
```

Expected: FAIL because batch orchestration is absent.

- [ ] **Step 4: Implement setup and launch barriers**

Sequence exactly:

```ts
const decoded = decodeSubagentRequest(request);
const discovery = yield * discoverAgents;
const tasks = yield * preflight({ request: decoded, discovery, parent });
const stores = yield * Effect.forEach(tasks, store.create, { concurrency: 1 });
return (
  yield *
  Effect.scoped(
    Effect.gen(function* () {
      const handles = yield* Effect.forEach(zip(tasks, stores), launchOne, {
        concurrency: 3,
      });
      yield* Effect.all(
        handles.map((handle) => handle.launched),
        { concurrency: 3 },
      );
      return yield* Effect.all(
        handles.map((handle) => handle.awaitResult),
        { concurrency: 3 },
      );
    }),
  )
);
```

Do not expose results before every handle confirms launch. Keep arrays indexed by request position.

- [ ] **Step 5: Implement rollback semantics**

If artifact setup or any launch acknowledgement fails, interrupt the shared scope, best-effort transition every created run to infrastructure `FAILED`, collect status-write diagnostics, and fail the parent tool. After the launch barrier, do not interrupt siblings for semantic/process failures.

- [ ] **Step 6: Run batch tests**

Run:

```bash
bun --bun vitest run src/subagents/batch.test.ts --reporter dot
```

Expected: PASS.

- [ ] **Step 7: Commit batch orchestration**

```bash
git add src/subagents/batch.ts src/subagents/batch.test.ts
git commit -m "feat(subagents): orchestrate atomic child batches"
```

---

### Task 9: Register the Parent/Child Tools and Bounded Rendering

**Files:**

- Create: `src/subagents/render.ts`
- Create: `src/subagents/render.test.ts`
- Create: `src/subagents/index.ts`
- Create: `src/subagents/index.test.ts`

**Interfaces:**

- Consumes: `SubagentBatch`, `completeSubagent`, `makeEffectRunner`, Pi `ExtensionAPI`, TypeBox, StringEnum, and TUI `Text`/`Container`.
- Produces: the only extension entrypoint, `subagent` tool details/content, streaming `onUpdate`, and child-only completion registration.

- [ ] **Step 1: Write failing renderer tests**

Test a one-child partial view, three-child partial view, final mixed statuses, expanded artifact/usage details, and narrow widths. Assert no rendered line exceeds the supplied width and raw JSON/task bodies never appear.

The model-facing final formatter is exact and ordered:

```text
run-1 alpha DONE: Interfaces verified
run-2 beta BLOCKED: Missing fixture (/abs/report.md)
```

- [ ] **Step 2: Implement render helpers**

Export `formatModelResult(results)`, `renderSubagentCall(args, theme)`, and `renderSubagentResult(result, options, theme)`. Use `truncateToWidth`, status colors, and the bounded `ChildProgress` items; show paths/exit/signal/usage/diagnostics only when expanded.

- [ ] **Step 3: Write failing registration adapter tests**

Build a fake registration port and verify:

- parent environment registers only `subagent`;
- child marker registers only `complete_subagent`;
- parent parameters require `tasks` with `minItems: 1`, `maxItems: 3`, and required `agent`/`task`;
- parent tool uses `executionMode: "sequential"`;
- `execute` snapshots `ctx.cwd`, canonical `ctx.model.provider/id`, `pi.getThinkingLevel()`, and copied `pi.getAllTools()` provenance;
- the adapter implements `ModelResolutionPort` with Pi's exported `resolveCliModel({ cliModel: pattern, cliThinking: thinking, modelRegistry: ctx.modelRegistry })`, promotes resolver errors to preflight errors, preserves warnings in diagnostics, and freezes canonical `provider/id` plus the returned thinking level;
- undefined parent model is allowed into preflight and fails there only when inheritance is needed;
- tool AbortSignal is passed to `runner.runPromise(effect, { signal })`;
- batch progress calls `onUpdate` with concise content and complete structured details;
- final errors are thrown once with `formatSubagentError`;
- `session_shutdown` disposes the managed runtime idempotently.

- [ ] **Step 4: Define strict TypeBox boundary schemas**

Use:

```ts
const TaskParameters = Type.Object(
  {
    agent: Type.String({ minLength: 1, description: "Agent definition name" }),
    task: Type.String({
      minLength: 1,
      description: "Task for the child agent",
    }),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Existing child working directory",
      }),
    ),
  },
  { additionalProperties: false },
);

const SubagentParameters = Type.Object(
  {
    tasks: Type.Array(TaskParameters, { minItems: 1, maxItems: 3 }),
  },
  { additionalProperties: false },
);
```

For child completion, use `StringEnum(["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"] as const)` and TypeBox summary/report fields; Effect Schema revalidates semantic constraints.

- [ ] **Step 5: Implement the single entrypoint**

Branch before registration:

```ts
export default function subagentsExtension(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    registerCompletionTool(pi);
    return;
  }
  registerParentTool(pi);
}
```

Parent Live layer merges `EnvironmentService.Live`, `HomeDirectoryService.Live`, `FileSystemService.Live`, and `ProcessService.Live`. Capture `fileURLToPath(import.meta.url)` as the explicit completion entrypoint passed to children. The child branch must not construct parent runtime state or register nested delegation.

- [ ] **Step 6: Run renderer/adapter tests**

Run:

```bash
bun --bun vitest run src/subagents/render.test.ts src/subagents/index.test.ts --reporter dot
```

Expected: PASS.

- [ ] **Step 7: Commit the Pi adapter**

```bash
git add src/subagents/render.ts src/subagents/render.test.ts src/subagents/index.ts src/subagents/index.test.ts
git commit -m "feat(subagents): register parent and child tools"
```

---

### Task 10: Add Credential-Free Real-Process Integration Coverage

**Files:**

- Create: `test/fixtures/fake-pi.ts`
- Create: `src/subagents/subagents.integration.test.ts`

**Interfaces:**

- Consumes: live filesystem/process services, `RunStore`, `RunExecutor`, and `SubagentBatch`.
- Produces: executable evidence for real JSONL/stderr streaming, overlap, failure, rollback, and cancellation without model credentials.

- [ ] **Step 1: Write the fake Pi executable**

Implement modes selected by the task file's first line: `success`, `blocked`, `missing-completion`, `malformed`, `nonzero`, `launch-delay`, and `stall`. It must parse `@task.md` and `--append-system-prompt` paths from `process.argv`, reject task text appearing as a direct argv item, emit a valid session header plus current Pi 0.80.6 event shapes, write a stderr marker, and handle SIGTERM by either exiting or stalling for SIGKILL tests.

A success stream must include one assistant message with one completion tool call and its successful `tool_execution_end` details before `agent_settled`.

- [ ] **Step 2: Write integration tests for the approved scenarios**

Cover:

1. one successful child;
2. three unrestricted tasks with overlapping start/end timestamps;
3. mixed allowlists, including mutation-capable tools;
4. mixed semantic outcomes;
5. nonzero process failure and missing completion;
6. rollback after partial launch failure;
7. cancellation producing `ABORTED` and observed SIGTERM/SIGKILL policy;
8. real stdout/stderr streaming retained in artifacts.

Use temporary agent/run directories and always remove the test sandbox in `Effect.acquireUseRelease`.

- [ ] **Step 3: Run integration tests and verify RED, then GREEN**

Run before wiring fixtures into the executor test harness:

```bash
bun --bun vitest run src/subagents/subagents.integration.test.ts --reporter verbose
```

Expected initial result: FAIL because fake invocation injection is not connected.

Inject only the executable selector as a test dependency of `buildChildInvocation`; do not add a public config/environment variable. Run the same command again.

Expected final result: PASS with no network or model credentials.

- [ ] **Step 4: Commit integration coverage**

```bash
git add test/fixtures/fake-pi.ts src/subagents/subagents.integration.test.ts
git commit -m "test(subagents): cover real process execution"
```

---

### Task 11: Wire Package Discovery and Living Specifications

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `test/package-manifest.test.ts`
- Create: `docs/specs/subagents.md`
- Create: `docs/specs/file-system-service.md`
- Modify: `docs/specs/index.md`
- Modify: `docs/specs/extensions.md`
- Modify: `docs/specs/process-service.md`
- Modify: `docs/specs/test-services.md`

**Interfaces:**

- Consumes: completed public/service behavior from Tasks 1–10.
- Produces: package discovery, declared runtime imports, and accurate owning specifications.

- [ ] **Step 1: Write failing manifest tests**

Update expectations to require stable extension order with one new entrypoint:

```ts
expect(packageJson.pi.extensions).toEqual([
  "./src/attention-hooks/index.ts",
  "./src/custom-footer/index.ts",
  "./src/history-picker/index.ts",
  "./src/subagents/index.ts",
]);
expect(packageJson.dependencies).toMatchObject({
  effect: expect.any(String),
  typebox: expect.any(String),
});
expect(packageJson.peerDependencies).toMatchObject({
  "@earendil-works/pi-ai": "*",
  "@earendil-works/pi-coding-agent": "*",
  "@earendil-works/pi-tui": "*",
});
```

Also assert no separate completion entrypoint is listed.

- [ ] **Step 2: Run manifest test and verify RED**

Run:

```bash
bun --bun vitest run test/package-manifest.test.ts --reporter dot
```

Expected: FAIL because package metadata is not wired.

- [ ] **Step 3: Update package metadata with Bun**

Add `./src/subagents/index.ts`; add `typebox` to `dependencies`; add `@earendil-works/pi-ai` to `peerDependencies` as `*` and to `devDependencies` at the pinned `^0.80.6` range. Do not add `yaml`; use Pi's exported `parseFrontmatter`.

Run:

```bash
bun install
bun --bun vitest run test/package-manifest.test.ts --reporter dot
```

Expected: PASS and `bun.lock` updated only as required.

- [ ] **Step 4: Write the owning subagent specification**

Create `docs/specs/subagents.md` under approximately 300 lines. Describe public task shape, global definition location/frontmatter, uniform concurrency, selective loading, completion contract, artifacts/permissions, lifecycle, rollback/cancellation, ordered results, progress bounds at a behavioral level, and milestone-2 exclusions. Cross-reference process/filesystem/extension specs instead of copying implementation details.

- [ ] **Step 5: Write the filesystem service specification**

Create `docs/specs/file-system-service.md` describing generic metadata/list/read/private create-write-append/realpath/rename/remove operations, typed failures, copied results, and why atomic/private operations exist. Do not mention subagent-specific filenames except through a cross-reference.

- [ ] **Step 6: Update existing spec owners minimally**

- Add both new specs to `docs/specs/index.md`.
- Add Subagents to `docs/specs/extensions.md` current extensions and validation list.
- Add replayable launch acknowledgement to `docs/specs/process-service.md`.
- Add indexed concurrent child controls and expanded filesystem fake behavior to `docs/specs/test-services.md`.

- [ ] **Step 7: Commit package and specifications**

```bash
git add package.json bun.lock test/package-manifest.test.ts docs/specs/subagents.md docs/specs/file-system-service.md docs/specs/index.md docs/specs/extensions.md docs/specs/process-service.md docs/specs/test-services.md
git commit -m "docs(subagents): publish milestone one contracts"
```

---

### Task 12: Validate, Smoke-Test, and Review the Milestone

**Files:**

- Review: all files changed from `main...HEAD`
- Modify only if validation/review identifies a defect: the owning source/test/spec file

**Interfaces:**

- Consumes: complete implementation and specs.
- Produces: reproducible validation evidence, extension-load evidence, and an independently reviewed final diff.

- [ ] **Step 1: Run focused subagent and shared-service suites**

```bash
bun --bun vitest run src/subagents src/services/file-system.test.ts src/services/process.test.ts src/lib/effect-runtime.test.ts test/services/file-system.test.ts test/services/process.test.ts test/package-manifest.test.ts --reporter dot
```

Expected: all selected files and tests pass.

- [ ] **Step 2: Run repository validation**

```bash
bun run check
```

Expected: source/test/kit typechecks, ESLint, and all Vitest suites pass.

- [ ] **Step 3: Validate isolated linking and unlinking**

```bash
sandbox="$(mktemp -d)"
PI_CODING_AGENT_DIR="$sandbox/agent" bun run pi:link-global
test "$(readlink "$sandbox/agent/extensions/pi-extensions")" = "$(pwd -P)"
PI_CODING_AGENT_DIR="$sandbox/agent" bun run pi:unlink-global
test ! -e "$sandbox/agent/extensions/pi-extensions"
rm -rf "$sandbox"
```

Expected: every command exits 0 and no sandbox link remains.

- [ ] **Step 4: Smoke-load both entrypoint branches without credentials**

Use Pi's list-only startup so no provider call occurs:

```bash
bun node_modules/@earendil-works/pi-coding-agent/dist/cli.js --offline --no-extensions -e ./src/subagents/index.ts --list-models >/tmp/pi-subagents-parent-smoke.txt
PI_SUBAGENT_CHILD=1 bun node_modules/@earendil-works/pi-coding-agent/dist/cli.js --offline --no-extensions -e ./src/subagents/index.ts --list-models >/tmp/pi-subagents-child-smoke.txt
```

Expected: both commands exit 0 with no extension-load diagnostic on stderr.

- [ ] **Step 5: Review the final diff and specification map**

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
git diff --name-only main...HEAD -- .context
```

Expected: no whitespace errors, no unexpected worktree changes, and no `.context` paths. Map `src/subagents/**` to `docs/specs/subagents.md`, filesystem changes to `docs/specs/file-system-service.md`, process changes to `docs/specs/process-service.md`, fake changes to `docs/specs/test-services.md`, and manifest/entrypoint changes to `docs/specs/extensions.md`.

- [ ] **Step 6: Request independent code review**

Use `superpowers:requesting-code-review` with three fresh read-only angles: correctness/races, tests/failure coverage, and security/privacy/spec compliance. Require file/line evidence and no edits. Resolve every blocker and every fix worth doing now with a single editing owner, rerun the focused suite and `bun run check`, and repeat focused review if fixes materially change orchestration or storage.

- [ ] **Step 7: Commit review fixes when needed**

If review changed files:

```bash
git add src test package.json bun.lock docs/specs
git commit -m "fix(subagents): address milestone review"
```

If review found no change worth making, do not create an empty commit.

- [ ] **Step 8: Record final evidence**

Capture exact command outputs, test counts, smoke-test exit codes, changed specifications, and residual Pi 0.80.6 limitations in the completion summary. In particular, state that public provenance detects the winning provider only and that child project skills follow Pi's existing non-interactive trust policy.
