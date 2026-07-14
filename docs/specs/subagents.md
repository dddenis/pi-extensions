# Subagents

## Purpose and Surface

The Subagents extension runs small, isolated batches of fresh Pi child processes while preserving bounded concurrency, private durable evidence, and structured outcomes. It has one package-discovered entrypoint. In a normal parent environment that entrypoint registers only the sequential `subagent` tool; when `PI_SUBAGENT_CHILD=1`, it registers only the child-facing `complete_subagent` tool. The completion implementation is not a separate package entrypoint.

A parent request contains a required `tasks` array of one to three items. Each item has a non-empty single-line agent name, a non-empty task, and an optional non-empty single-line working directory. A working directory defaults to the parent context directory; relative values resolve from that directory, and the result must be an existing directory. The complete request and batch policy pass preflight before any run artifact or process is created.

Tasks within one accepted request may run concurrently. Results always preserve request order, regardless of launch or completion order. Pi serializes separate `subagent` tool calls through the tool's sequential execution mode.

## Global Agent Definitions

Definitions are rediscovered on every invocation from direct Markdown files in `<agent-dir>/subagents/agents/`. `<agent-dir>` follows the configured Pi agent-directory behavior described by [Extensions](./extensions.md). Project-local definition directories are not part of milestone one.

Each definition has YAML frontmatter and a non-empty Markdown role prompt. Its supported frontmatter is:

| Field         | Required | Contract                                                     |
| ------------- | -------: | ------------------------------------------------------------ |
| `name`        |      yes | Trimmed, non-empty, single-line public identifier            |
| `description` |      yes | Trimmed, non-empty, single-line description                  |
| `model`       |       no | Pi model pattern or canonical model identifier               |
| `thinking`    |       no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools`       |       no | Non-empty comma-separated unique tool allowlist              |

Unknown fields, invalid values, an empty role prompt, or an unreadable file exclude that definition and produce a diagnostic without hiding valid neighbors. A missing definitions directory is empty discovery. A lookup is reported as genuinely missing only after complete discovery; directory probe/read failures report unavailable discovery, while unreadable or unparseable definitions whose names cannot be known make an otherwise absent lookup indeterminate. A requested named-invalid or duplicate definition fails with all matching definition diagnostics and paths. Every definition sharing a duplicate name is excluded. The resolved execution data copied into the durable manifest contains identity, model, thinking, tools, provider extensions, and the definition path, while the role prompt and completion requirements are preserved in the composed system-prompt artifact. Together these durable artifacts prevent later definition edits from changing an active run.

An omitted model inherits the parent model. An explicit model is resolved with Pi's CLI model semantics; the resolved canonical model and Pi-adjusted thinking level are used. Thinking otherwise inherits from the parent. Resolution warnings remain visible in progress and final diagnostics, while resolution errors fail preflight.

## Tool Policy

Tool allowlists control child tool availability and external provider loading; they do not classify agents or affect whether tasks may run concurrently. An omitted allowlist leaves Pi's normal child tool set available, while a declared allowlist is passed to the child together with `complete_subagent`.

Children start with normal extension discovery disabled. For every declared tool, preflight requires exactly one parent-reported provider. Built-ins need no extension. SDK tools, synthetic provider paths, missing or ambiguous provenance, and non-file providers are rejected. Loadable external provider paths are canonicalized and deduplicated in first-use order. The child loads only the Subagents entrypoint and those required provider extensions; `subagent` and `complete_subagent` are reserved and cannot be requested by a definition.

Pi 0.80.6 exposes only the winning registration for each tool through its public tool inventory. Core preflight rejects duplicates when they are supplied, but the live adapter cannot detect registrations Pi already collapsed and therefore validates only the visible winning provider.

Disabling extension discovery does not disable normal project context discovery. Project skills follow Pi's saved non-interactive trust decision for each child working directory; the extension does not force project trust.

## Child Invocation and Environment

Children run Pi in JSON print mode without a session and without shell interpolation. Task text is read from its private artifact file rather than appearing directly in the process argument list. The child receives the resolved model and thinking level, the declared allowlist plus `complete_subagent` when an allowlist exists, the internal completion extension, and required external providers.

The child environment copies the inherited parent environment and sets `PI_SUBAGENT_CHILD=1`. The composed system prompt appends the definition's role prompt, prohibits nested delegation, and requires structured completion. Nested subagents are also unavailable because the child branch does not register the parent tool.

[Process Service](./process-service.md) owns launch acknowledgement, streams, scoped shutdown, and bounded EOF/SIGTERM/SIGKILL cleanup.

## Completion and Finality

`complete_subagent` accepts one semantic status—`DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`—plus a trimmed non-empty single-line summary of at most 500 Unicode code points and an optional absolute report path. A report must resolve to an existing regular file; the canonical path becomes the result. Invalid calls remain child-visible so the model can correct them.

A semantic result is accepted only when exactly one `complete_subagent` call is the sole tool call in its assistant message, its successful exact tool result correlates by call ID, no later assistant or unrelated tool work invalidates it, the agent settles, and the process exits successfully. Child runtime is unbounded, while output draining after the direct child exits has one shared deadline so a descendant retaining inherited descriptors cannot keep a run active forever. Output that drains within that deadline is processed normally; expiry releases local output ownership and produces `FAILED` with the known exit and a truncation diagnostic, even if semantic completion was previously observed. An output stream failure initiates bounded process cleanup immediately rather than waiting indefinitely for natural exit. Provider error or aborted stops, malformed recognized events, malformed non-empty JSON, stream or process failures, missing settlement or completion, unsuccessful exits, and truncated post-exit evidence produce `FAILED`. Raw completion transport is not trusted as final merely because it appeared once.

## Durable Runs and Status

Runs live under `<agent-dir>/subagents/runs/<run-id>/` and contain a manifest, task, composed system prompt, raw JSONL events, stderr log, and status record. Directories are created with mode `0700` and files with mode `0600`. Run artifacts are retained until the user manually removes them; milestone one has no pruning or cleanup action. [File System Service](./file-system-service.md) owns the generic operations used for private creation and atomic status replacement.

The manifest records creation time, request index and working directory, resolved agent configuration and provider paths, definition path, and all artifact paths. Raw stdout events are appended before interpretation, stderr is retained separately, and usage is accumulated from final assistant-message events.

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
