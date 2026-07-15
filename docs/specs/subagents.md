# Subagents

## Purpose and Surface

The Subagents extension runs small, isolated batches of fresh Pi child processes while preserving bounded concurrency, private durable evidence, and structured outcomes. In a normal parent environment its package entrypoint registers only the sequential `subagent` tool; when `PI_SUBAGENT_CHILD=1`, it registers only `complete_subagent`.

A parent request contains one to three tasks. Each task has a required non-empty instruction, an optional existing working directory, and an optional agent name that defaults to the always-available builtin `general`. Complete preflight still occurs before any run artifact or process is created, and results preserve request order.

## Agent Catalog

Every invocation begins with an embedded `general` definition for arbitrary isolated work, then rediscovers optional user-global Markdown definitions from `<agent-dir>/subagents/agents/`. A valid unique global definition shadows a builtin of the same name. Invalid or duplicate global `general` candidates remain diagnostic while the builtin fallback stays selectable; discovery failures likewise do not prevent builtin selection. Explicit specialized names retain the existing missing, unavailable, indeterminate, and named-invalid failures.

Global frontmatter supports `name`, `description`, optional `model`, and optional `thinking`. Tool capability is not definition configuration. Unknown fields, including the removed `tools` field, invalidate a global definition. The resolved source is `builtin` or `global`, and only a global definition has a definition path.

An omitted model inherits the parent model. An explicit model is resolved with Pi's CLI model semantics; the resolved canonical model and Pi-adjusted thinking level are used. Thinking otherwise inherits from the parent. Resolution warnings remain visible in progress and final diagnostics, while resolution errors fail preflight.

## Parent Tool Inheritance

At invocation start the extension copies the parent's active tool names separately from all configured provider metadata. The durable parent snapshot preserves that captured sequence exactly, including duplicate entries. Preflight resolves one frozen capability plan in active-parent order and shares it across every task. Configured but inactive tools are not inherited, and later parent changes cannot alter an active batch.

`subagent` and any parent `complete_subagent` entry are filtered as reserved policy. An active name that cannot be represented as exactly one unchanged non-empty item in Pi's single `--tools` transport is omitted with a sanitized durable diagnostic, preventing delimiter or whitespace reinterpretation. Builtins remain available without an extension. Active file-backed tools load through canonical provider paths deduplicated in first-use order. Missing, ambiguous, SDK-bound, synthetic, non-file, or uncanonicalizable providers are omitted with durable diagnostics rather than failing otherwise valid tasks. Effective child names remain unique, and `complete_subagent` is added exactly once, so a child may run with completion as its only tool.

Pi 0.80.7 exposes only the winning registration for each tool through its public tool inventory. Core preflight detects duplicates when they are supplied, but live duplicate detection is limited to the winning registration exposed by Pi.

## Child Invocation and Durable Evidence

Children keep normal extension discovery disabled and load only the completion extension plus providers selected during preflight. Every command passes an explicit `--tools` list containing the frozen effective names. Additional tools registered by a loaded provider remain unavailable unless present in that list, including `subagent`.

The manifest records resolved agent source, a definition path only for global agents, the parent active-name snapshot, effective child names, canonical provider paths, and unsupported-inheritance diagnostics. Progress and final structured details retain those diagnostics separately from child semantic concerns; model-facing text remains limited to ordered child status, summary, and optional report path.

Disabling extension discovery does not disable normal project context discovery. Project skills follow Pi's saved non-interactive trust decision for each child working directory; the extension does not force project trust.

[Process Service](./process-service.md) owns launch acknowledgement, streams, scoped shutdown, and bounded EOF/SIGTERM/SIGKILL cleanup.

## Completion and Finality

`complete_subagent` accepts one semantic status—`DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`—plus a trimmed non-empty single-line summary of at most 500 Unicode code points and an optional absolute report path. A report must resolve to an existing regular file; the canonical path becomes the result. Invalid calls remain child-visible so the model can correct them.

A semantic result is accepted only when exactly one `complete_subagent` call is the sole tool call in its assistant message, its successful exact tool result correlates by call ID, no later assistant or unrelated tool work invalidates it, the agent settles, and the process exits successfully. Child runtime is unbounded, while output draining after the direct child exits has one shared deadline so a descendant retaining inherited descriptors cannot keep a run active forever. Output that drains within that deadline is processed normally; expiry releases local output ownership and produces `FAILED` with the known exit and a truncation diagnostic, even if semantic completion was previously observed. An output stream failure initiates bounded process cleanup immediately rather than waiting indefinitely for natural exit. Provider error or aborted stops, malformed recognized events, malformed non-empty JSON, stream or process failures, missing settlement or completion, unsuccessful exits, and truncated post-exit evidence produce `FAILED`. Raw completion transport is not trusted as final merely because it appeared once.

## Durable Runs and Status

Runs live under `<agent-dir>/subagents/runs/<run-id>/` and contain a manifest, task, composed system prompt, raw JSONL events, stderr log, and status record. Directories are created with mode `0700` and files with mode `0600`. Run artifacts are retained until the user manually removes them; milestone one has no pruning or cleanup action. [File System Service](./file-system-service.md) owns the generic operations used for private creation and atomic status replacement.

The manifest also records creation time, request index and working directory, and all artifact paths. Raw stdout events are appended before interpretation, stderr is retained separately, and usage is accumulated from final assistant-message events.

The status lifecycle is monotonic:

- `STARTING` may become `RUNNING`;
- cancellation may change `STARTING` directly to `ABORTED`;
- infrastructure rollback may change `STARTING` directly to marked `FAILED`;
- `RUNNING` may become any semantic status, `FAILED`, or `ABORTED`;
- a terminal status is immutable.

Status replacement is atomic and competing terminal commits elect one durable winner. `RunExecutor` owns each launched run's active store, artifact streaming, status commitment, and scoped process. When an execution outcome or executor-owned launch failure cannot commit its primary terminal record, the executor attempts a durable `FAILED` fallback; when neither outcome can be recorded, the tool fails explicitly rather than claiming a result. Cancellation does not use this fallback.

## Batch Lifecycle, Rollback, and Cancellation

After preflight, run stores are created before launches begin. Launches and launch acknowledgements form an atomic barrier: if creation, spawn, acknowledgement, or the `RUNNING` transition fails before every child acknowledges launch, every created run is marked `FAILED` with infrastructure-rollback diagnostics before the execution scope is interrupted. Rollback status-write failures are retained in the parent error. The extension never deliberately leaves a partially launched batch running.

After the barrier, children are independent. A semantic block or failure does not cancel siblings, and all results or await failures are collected before the ordered outcome is produced. Mixed semantic and `FAILED` child results are normal ordered results; process-service or store errors that escape a child remain tool failures and preserve additional indexed diagnostics.

Parent cancellation or session shutdown interrupts active invocations, attempts to record `ABORTED` for every created nonterminal run—including runs still in `STARTING`—and closes process scopes through bounded shared cleanup. If an executor-owned `ABORTED` transition fails, the executor best-effort appends a concise stderr diagnostic; it does not falsely claim `ABORTED` or force `FAILED`. Cancellation and late process events cannot overwrite an already committed terminal result. Concurrent parent invocations own independent runners, and shutdown is idempotent while waiting for all active invocations to settle.

## Progress, Privacy, and Results

Progress snapshots remain in request order and are serialized so concurrent children cannot publish regressing aggregate state. Snapshots and nested items are copied before publication. A throwing, failing, or slow progress callback cannot block launch acknowledgement or fail the child; the first callback failure is retained as a diagnostic when possible.

Each child exposes only `STARTING`, `RUNNING`, or `SETTLED`, aggregate usage, and the latest 12 bounded activity items. Assistant previews are limited to 240 Unicode code points. Tool activity reveals the tool name and the fixed preview `started`, never arguments, task text, partial results, or raw transport. Parent rendering is width-bounded; diagnostics, usage, process state, and artifact paths appear only in expanded details.

Child-owned and externally sourced display text is stripped of terminal-active sequences and control characters before parent TUI or model rendering. Private raw event and stderr artifacts remain unchanged for faithful evidence.

The model-facing final text contains only run ID, agent name, terminal status, summary, and optional report path in request order. Structured details also retain exit code, signal, usage, artifacts, and diagnostics. Discovery and preflight warnings remain separate from child execution diagnostics, survive successful preflight into progress and final structured details, and render only when expanded. Full child output is never injected into parent model context.

## Milestone-One Boundary

Milestone one has no chains or pipelines, management or kill commands, tmux ownership or detached survival, reconnection, capacity scheduling, acceptance gates, worktrees, automatic merging, automatic pruning, project-local definitions, or nested delegation. Those milestone-two concerns must reuse rather than fork the agent, run, completion, status, and executor contracts described here.
