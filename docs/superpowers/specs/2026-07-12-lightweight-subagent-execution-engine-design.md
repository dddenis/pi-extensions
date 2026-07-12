# Lightweight Subagent Execution Engine Design

**Date:** 2026-07-12
**Status:** Approved
**Source:** Adapted from `2026-07-10-lightweight-subagent-extension-design.md`

## 1. Purpose

Build the first milestone of a repository-native Pi subagent extension: a scoped execution engine for fresh child Pi processes with safe parallelism, live progress, structured completion, and durable artifacts.

This milestone deliberately separates execution correctness from tmux lifecycle management. A later design will add tmux-owned panes and surviving runs around the same execution core. For this repository, this document supersedes the milestone-1 execution decisions in the source design; that document remains historical input rather than an implementation contract.

## 2. Scope

Milestone 1 provides:

- one parent-facing `subagent` tool;
- a single task-array API for one to three children;
- isolated global markdown agent definitions;
- fresh Pi child processes using JSON mode;
- live, readable progress in the parent TUI;
- structured semantic completion;
- parent-local writer exclusivity;
- durable, user-private run artifacts; and
- scoped cancellation with bounded child cleanup.

Milestone 1 does not provide:

- chains, pipelines, or management actions;
- project-local agent definitions;
- parallel writers;
- `/subagents` or `/subagent-kill`;
- tmux panes, detached survival, reconnection, capacity management, or eviction;
- scheduling, acceptance gates, worktree management, or automatic merging;
- automatic run pruning; or
- nested subagent delegation.

The SDD controller remains responsible for sequencing implementers, reviewers, fixers, and final review.

## 3. Public tool contract

The tool accepts one shape:

```json
{
  "tasks": [
    {
      "agent": "reviewer",
      "task": "Review the affected interfaces.",
      "cwd": "/optional/working/directory"
    }
  ]
}
```

`tasks` is required and contains one to three items. One item means single execution; multiple items run concurrently. Every item requires a non-empty agent name and task. `cwd` is optional, defaults to the parent context's working directory, and must identify an existing directory.

The complete batch is validated before artifacts or processes are created. Results preserve input order regardless of completion order.

Pi serializes separate `subagent` tool calls. Accepted tasks inside one call may run concurrently.

## 4. Agent definitions

Definitions live only at:

```text
<agent-dir>/subagents/agents/*.md
```

`<agent-dir>` follows the repository's configured Pi agent-directory contract, including `PI_CODING_AGENT_DIR` and its default.

Each Markdown file contains YAML frontmatter and a non-empty role prompt. Supported fields are:

| Field         | Required | Contract                                                     |
| ------------- | -------: | ------------------------------------------------------------ |
| `name`        |      yes | Non-empty, trimmed, single-line public identifier            |
| `description` |      yes | Non-empty, trimmed, single-line description                  |
| `model`       |       no | Pi model pattern or `provider/model`                         |
| `thinking`    |       no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools`       |       no | Comma-separated tool allowlist                               |
| `writer`      |       no | Boolean; defaults to `true`                                  |

Unknown fields and invalid values invalidate that definition. Definitions are rediscovered for every invocation. Malformed files are excluded without blocking unrelated valid definitions. Every definition involved in a duplicate name is excluded rather than resolved by file ordering.

Model and thinking values omitted by the definition inherit the active parent session values. Pi remains responsible for clamping thinking to model capability.

The resolved definition is frozen into each run manifest. Later edits cannot change an active run's prompt, model, tools, or writer classification.

## 5. Writer policy

Writer exclusivity is intentionally parent-local. It protects runs dispatched by one parent Pi process; separate Pi sessions remain the user's responsibility.

`writer` defaults to `true`. A definition may declare `writer: false` only when it has an explicit tool allowlist containing solely approved project-read-only tools.

The initial reader-safe set is:

```text
read, grep, find, ls,
web_search, fetch_content, get_search_content
```

`bash`, mutation tools, omitted tools, unknown tools, and other custom tools make an agent a writer. The internal completion tool does not affect classification.

A batch may contain one writer alongside readers. A batch containing multiple writers is rejected. No override exists in milestone 1.

The web-access tools are project-read-only rather than side-effect-free: they may perform network requests and use memory, caches, temporary downloads, or temporary clones, but they do not modify the delegated project by contract. Browser automation is not reader-safe.

## 6. Selective extension loading

Children do not automatically execute every installed extension.

The parent uses Pi tool provenance to resolve requested non-built-in tools to unique, loadable provider extensions. The child starts with normal extension discovery disabled, then explicitly loads:

1. the internal completion extension; and
2. the provider extensions required by the agent's declared external tools.

Unavailable, ambiguous, or non-loadable tool provenance fails preflight. Built-in tools require no provider extension. Project context and skills remain available because only extension discovery is disabled.

The child environment preserves the inherited environment and adds `PI_SUBAGENT_CHILD=1`. The active tool set is the resolved agent allowlist, when present, plus the internal completion tool. Nested delegation is absent both because the parent extension is not loaded and because the composed system prompt prohibits it.

## 7. Structured completion

The child-only `complete_subagent` tool accepts:

- `status`: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`;
- `summary`: a required, trimmed, non-empty, single-line string of at most 500 characters; and
- `reportPath`: an optional absolute path.

When supplied, `reportPath` must resolve to an existing regular file. Invalid calls fail inside the child so the model can correct them. The composed prompt requires a valid completion to be the sole final tool call. The tool asks Pi to terminate the child agent loop cleanly, and subsequent agent work after its result invalidates the completion.

A successful process exit without a valid final completion call is `FAILED`. A nonzero exit, malformed JSON stream, invalid report, process failure, or run-store failure is also `FAILED`, regardless of an earlier semantic completion attempt.

Agent prompts may impose stronger requirements, such as requiring an implementer report. The generic runtime permits completion without a report so lightweight readers need not create one.

## 8. Durable run contract

Runs live under:

```text
<agent-dir>/subagents/runs/<run-directory>/
├── run.json
├── task.md
├── system-prompt.md
├── events.jsonl
├── stderr.log
└── status.json
```

Run directories use mode `0700` and files use mode `0600`. Runs are retained until manually deleted; milestone 1 has no pruning policy or cleanup command.

`system-prompt.md` combines the agent role prompt, the nested-delegation prohibition, and the structured-completion requirement. It is appended to Pi's default system prompt so normal project context and skills remain available.

Task contents are transported by file reference rather than placed directly in the process list. Child processes are launched with argument arrays and never through interpolated shell commands.

## 9. Status model

Every run follows a monotonic lifecycle:

```text
STARTING -> RUNNING -> terminal
```

Terminal statuses are:

- `DONE`;
- `DONE_WITH_CONCERNS`;
- `NEEDS_CONTEXT`;
- `BLOCKED`;
- `FAILED`; and
- `ABORTED`.

Terminal status is immutable. Status replacement is atomic, while transition validation prevents a late process event from overwriting an authoritative terminal outcome.

`ABORTED` is reserved for parent cancellation or shutdown in the scoped milestone-1 host. Infrastructure setup or batch rollback records `FAILED`.

## 10. Architecture

Production code lives under `src/subagents/`; only `src/subagents/index.ts` is a Pi extension entrypoint.

The design separates:

- the Pi registration and rendering adapter;
- agent discovery and validation;
- run storage and status transitions;
- external-tool provenance resolution;
- batch preflight and writer policy; and
- a host-independent `RunExecutor`.

The `RunExecutor` owns command construction, process lifecycle, JSON event decoding, artifact streaming, progress events, completion validation, and terminal status commitment. It contains no parent-TUI or tmux assumptions.

Milestone 1 invokes the executor directly inside the tool's Effect scope. Milestone 2 can invoke the same executor from a pane-owned executable without changing the run contract.

Pi tool parameters use TypeBox at the host boundary. Effect Schema decodes domain inputs, frontmatter, manifests, Pi events used by the feature, completion results, and statuses. Promise-returning Pi callbacks remain thin adapters around Effect programs.

Generic filesystem capabilities extend the shared `FileSystemService`. Child processes reuse the shared `ProcessService`. Effect time, scopes, concurrency, and finalizers own orchestration rather than ad hoc Promise lifecycle code.

## 11. Execution flow

For each tool call, the extension:

1. decodes the one-to-three-task request;
2. discovers agent definitions and available tool provenance;
3. resolves each working directory, model, thinking level, tools, and writer classification;
4. rejects unsafe readers, missing tools, multiple writers, or other preflight errors;
5. creates all run artifacts with `STARTING` status;
6. launches the accepted runs with bounded concurrency;
7. streams progress to the parent TUI;
8. waits for every child to finish; and
9. returns ordered concise results.

If setup or launch fails partway through, started children are terminated and every created run records an infrastructure failure. The extension never leaves a deliberately partial batch running. A batch that fails before all children launch throws a Pi tool error after best-effort status recording; only fully launched batches return the ordered result array.

After every child in a batch has launched successfully, outcomes are independent. A failed or blocked child does not cancel its siblings.

Parent cancellation interrupts the execution scope. Shared process cleanup requests EOF, then bounded graceful termination, then forced termination when necessary. Run finalizers record `ABORTED`. The parent turn may end without receiving a normal tool result, but durable artifacts preserve the outcome.

## 12. Progress and results

JSON mode supplies machine-readable assistant, tool, stop, and usage events. Raw events are retained in `events.jsonl`; stderr is retained separately.

The parent TUI renders bounded per-child activity, including assistant-text previews and tool calls, without displaying raw JSON. Unknown valid JSON event types are retained and ignored for progress. Malformed non-empty output fails the run.

The model-facing final result includes, in request order:

- run ID;
- agent name;
- terminal status;
- summary; and
- optional report path.

Structured tool-result details retain nullable exit code, signal, usage, run directory, artifact paths, and diagnostics. Full child output is not injected into the parent model context.

## 13. Error model

Tagged errors distinguish at least:

- invalid tool input;
- missing, malformed, or duplicate agent definitions;
- unsafe reader configuration;
- unavailable or ambiguous tool providers;
- invalid working directories;
- writer-policy violations;
- run-store or permission failures;
- process launch or termination failures;
- malformed Pi event streams; and
- missing or invalid completion results.

Errors are rendered once at the Pi boundary. Preflight failures create no artifacts. Failures after artifact creation retain inspectable terminal records rather than deleting evidence.

## 14. Testing and validation

Tests use no model credentials or real API calls.

Pure and service tests cover:

- frontmatter decoding, duplicate handling, and parent inheritance;
- one-to-three-task validation and ordered results;
- reader-safe classification and writer rejection;
- external-tool provenance resolution;
- shell-free command construction;
- JSON event decoding and bounded progress;
- completion and report validation;
- atomic monotonic status transitions;
- private artifact permissions and manual retention; and
- cancellation with bounded process cleanup.

Integration tests cover:

- one successful child;
- three parallel readers;
- one writer with readers;
- mixed semantic outcomes;
- process failure and missing completion;
- rollback after partial launch failure;
- cancellation producing `ABORTED`; and
- real process streaming through a fake Pi executable.

Repository validation includes `bun run check`, isolated package-link validation, and an extension-load smoke test.

## 15. Living specification impact

Implementation introduces `docs/specs/subagents.md` as the owning behavior contract. If shared filesystem capabilities expand, `docs/specs/file-system-service.md` owns that service contract.

`docs/specs/index.md` and `docs/specs/extensions.md` add the new domains and extension. Existing architecture, process, test-service, and attention-hook specifications change only if their owned contracts change.

## 16. Milestone 2 boundary

After milestone 1 is implemented and validated, tmux lifecycle receives a separate design and implementation plan. That milestone may add:

- tmux-owned pane processes;
- child survival after parent cancellation or reload;
- pane discovery and reconnection;
- `/subagents` and `/subagent-kill`;
- capacity, retention, eviction, and watchdog behavior; and
- host-specific waiting semantics.

It must reuse the milestone-1 agent, run, completion, status, and executor contracts rather than create a second execution engine.
