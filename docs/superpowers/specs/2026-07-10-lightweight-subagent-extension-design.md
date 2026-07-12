# Lightweight Subagent Extension Design

**Date:** 2026-07-10
**Status:** Approved

## 1. Purpose

Build a lightweight pi extension for Superpowers’ Subagent-Driven Development (SDD) workflow. The extension delegates work to fresh, non-interactive pi processes displayed in panes in the parent pi process’s current tmux window.

The design favors a small, explicit feature set:

- one parent-facing `subagent` tool;
- `/subagents` and `/subagent-kill` commands;
- single and bounded-parallel execution;
- global markdown agent definitions;
- visible child output;
- file-based reports and deterministic statuses;
- writer exclusivity by default; and
- reconnection to surviving panes after reloading or reopening parent pi.

The implementation is built throughout on Effect and runs with Bun.

## 2. Goals

- Work with the Superpowers SDD controller’s implementer, reviewer, and fixer dispatches.
- Give each child a fresh pi context and a precise delegated prompt.
- Show up to three children in vertically stacked panes on the right side of the parent’s tmux window.
- Keep the parent pi pane on the left and restore focus to it after spawning children.
- Let the parent block for normal SDD dispatches while allowing children to survive parent cancellation, reload, or shutdown.
- Return a predictable status and report reference to the parent agent.
- Prevent accidental concurrent writers while allowing bounded parallel read-only work.
- Keep child logs and reports inspectable without introducing a scheduler or database.

## 3. Non-goals

Version 1 will not provide:

- chain or pipeline execution;
- acceptance policies or completion gates;
- scheduled or background orchestration APIs;
- project-local agent definitions;
- nested subagent delegation;
- automatic restoration after a machine reboot;
- automatic continuation of a parent tool call after parent pi restarts;
- an SDK-based replacement for the pi CLI;
- interactive child pi TUIs;
- a persistent job scheduler or database;
- bundled example agent prompts; or
- automatic merging or worktree management.

The SDD controller remains responsible for sequencing implementer, reviewer, fixer, and final-review steps.

## 4. Runtime requirements

The extension requires:

- pi;
- Bun; and
- tmux.

Parent pi must already be running inside tmux. Calls made outside tmux fail before creating a run directory or child process.

## 5. Filesystem layout

All extension-owned configuration and run artifacts live under one global root:

```text
~/.pi/agent/subagents/
├── agents/
│   └── <agent>.md
└── runs/
    └── <timestamp>-<run-id>-<agent>/
        ├── run.json
        ├── task.md
        ├── system-prompt.md
        ├── stdout.log
        ├── stderr.log
        └── status.json
```

Only `~/.pi/agent/subagents/agents/*.md` is searched for agent definitions. Project-local definitions and fallback search paths are intentionally unsupported.

Run directories are durable artifacts, not a queue. Machine reboot starts with no live managed panes even if old run directories remain.

## 6. Agent definitions

Each agent is a markdown file containing YAML frontmatter followed by its role-specific system prompt.

```markdown
---
name: implementer
description: Implements one SDD task
model: openai-codex/gpt-5.5
thinking: xhigh
tools: read,bash,edit,write
writer: true
---

You are an implementation agent. Read the supplied task brief first...
```

### 6.1 Frontmatter schema

| Field | Required | Meaning |
|---|---:|---|
| `name` | yes | Unique public agent name |
| `description` | yes | Short description shown to the parent model |
| `model` | no | Child pi model pattern or `provider/model` |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `tools` | no | Comma-separated pi tool allowlist |
| `writer` | no | Boolean; defaults to `false` |

Agent discovery happens for each invocation so definitions can be edited without restarting parent pi. Invalid files are excluded and reported with their path and validation errors; they do not prevent unrelated valid agents from running. When multiple valid files declare the same name, every conflicting definition is excluded and the duplicate is reported rather than resolved by ordering.

`writer` is an explicit scheduling declaration. The extension does not attempt to infer write capability from tool names. These files are global user-owned configuration and therefore trusted.

### 6.2 Prompt composition

The markdown body is appended to pi’s default system prompt using `--append-system-prompt`. It does not replace pi’s coding instructions, project context discovery, or skill availability.

For each run, `system-prompt.md` contains:

1. the selected agent’s markdown body;
2. an instruction prohibiting nested delegation; and
3. the required final-status contract.

The delegated task is stored separately in `task.md` and sent as the child’s user prompt.

## 7. Public API

No public tool or command name includes `tmux` as a prefix or suffix.

### 7.1 `subagent` tool

The tool supports exactly two invocation shapes.

#### Single child

```json
{
  "agent": "implementer",
  "task": "Read the task brief at ... and implement it.",
  "cwd": "/path/to/worktree"
}
```

#### Parallel children

```json
{
  "tasks": [
    {
      "agent": "reviewer",
      "task": "Review the supplied package.",
      "cwd": "/path/to/worktree"
    },
    {
      "agent": "scout",
      "task": "Inspect the affected interfaces.",
      "cwd": "/path/to/worktree"
    }
  ],
  "allowParallelWriters": false
}
```

Each task item contains `agent`, `task`, and an optional `cwd`. `cwd` defaults to the parent extension context’s working directory.

Validation rules:

- exactly one of single or parallel mode must be provided;
- parallel mode accepts one to three tasks;
- every agent must resolve to a valid global definition;
- every supplied working directory must exist;
- pane capacity for the complete request must be available or safely reclaimable;
- multiple requested writers are rejected unless `allowParallelWriters` is `true`; and
- a writer is rejected while another writer is running unless `allowParallelWriters` is `true`.

One writer may run concurrently with non-writer agents. The extension prevents concurrent writers; it does not attempt to prove that readers and writers use independent working directories.

The tool blocks until every spawned child reaches a terminal status. Parallel waits are concurrent and preserve input ordering in the returned result.

### 7.2 Tool result

Each returned child result includes:

- run ID;
- agent name;
- terminal status;
- concise summary;
- optional report path;
- process exit code;
- run directory;
- stdout and stderr log paths; and
- pane ID when still available.

The model-facing text is concise. Full structured data is retained in tool-result details.

### 7.3 `/subagents`

`/subagents` lists managed child panes associated with the current parent pane in the current tmux window. For each run it shows:

- run ID;
- agent;
- status;
- pane ID;
- start or completion time; and
- run directory.

It reports live and retained panes only. It does not scan old run directories to present historical jobs after reboot.

### 7.4 `/subagent-kill`

```text
/subagent-kill <run-id>
/subagent-kill all
```

For a running child, the command terminates and closes the pane, atomically records `ABORTED` after termination, and signals the run’s wait channel so a blocked parent tool can return. Writing the status after pane termination prevents the dying wrapper from overwriting `ABORTED`. For a retained terminal child, the command closes the pane while leaving the run directory intact.

Unknown or ambiguous run IDs produce an error without affecting panes.

## 8. Child result contract

Every child is instructed to finish its final answer with this exact block:

```text
STATUS: DONE
REPORT: /absolute/path/to/report.md
SUMMARY: Implemented the task and passed 12 tests
```

Allowed model-reported statuses are:

- `DONE`;
- `DONE_WITH_CONCERNS`;
- `NEEDS_CONTEXT`; and
- `BLOCKED`.

`REPORT` is either an absolute path or `NONE`. When it is a path, the wrapper requires it to name an existing regular file before accepting a successful model-reported status. The wrapper validates the block at the end of stdout rather than searching arbitrary earlier output.

The wrapper owns `status.json`. The model never writes that file directly.

The wrapper adds infrastructure statuses:

- `RUNNING` while the child process is active;
- `FAILED` when pi exits unsuccessfully, the contract is missing or malformed, or the wrapper fails; and
- `ABORTED` after explicit termination through `/subagent-kill`.

A zero pi exit code without a valid final block is `FAILED`, not implicitly successful.

## 9. Pane layout and ownership

### 9.1 Layout

```text
┌──────────────────────────┬──────────────────┐
│                          │ child 1          │
│                          ├──────────────────┤
│ parent pi                │ child 2          │
│                          ├──────────────────┤
│                          │ child 3          │
└──────────────────────────┴──────────────────┘
```

- The parent remains the large left pane.
- Managed children occupy an approximately 40% wide right column.
- Child panes have equal heights.
- Layout is recalculated after spawn, eviction, or kill.
- Focus returns to the parent after pane operations.
- Pane IDs and pane options are authoritative; pane titles are presentation only.

### 9.2 Window ownership

To guarantee the layout, the first spawn requires the current tmux window to contain only the parent pane. Once managed panes exist, any unrelated pane in the window causes future spawns to fail rather than rearranging or terminating user-owned panes.

### 9.3 Capacity and eviction

At most three managed child panes may exist.

Before spawning a request, the extension computes how many slots are required. If capacity is insufficient, it evicts the oldest retained pane whose status is exactly `DONE` until enough slots are available.

The following statuses are protected from automatic eviction:

- `RUNNING`;
- `DONE_WITH_CONCERNS`;
- `NEEDS_CONTEXT`;
- `BLOCKED`;
- `FAILED`; and
- `ABORTED`.

If insufficient capacity remains after considering safe evictions, the request fails before spawning any member of the batch. This makes parallel spawn atomic with respect to capacity validation.

Each child pane enables tmux’s remain-on-exit behavior so its final visible output stays available after the wrapper exits.

## 10. Reconnection and lifecycle

Each child pane is tagged with tmux pane options containing:

- run ID;
- owning parent pane ID;
- agent name; and
- run-directory path.

The extension scans the current tmux window on session start and before every tool or command operation. It adopts only panes tagged for the current parent pane.

This supports:

- pi extension reload while child panes survive;
- closing parent pi, returning to the shell in the same pane, and reopening pi; and
- listing, killing, and capacity-managing the same child panes afterward.

Closing parent pi does not kill children. Aborting the parent tool stops its local wait operations but does not kill child panes. Child termination is explicit through `/subagent-kill` or manual tmux interaction.

A restarted parent cannot resume the old in-flight tool call or automatically inject a completed result into the model conversation. It reconnects for pane management only.

After machine reboot, tmux panes no longer exist. The extension starts with zero managed panes and ignores old run directories for live-state reconstruction. Superpowers’ SDD ledger and task reports remain responsible for determining which development task should be dispatched next.

## 11. Execution flow

### 11.1 Parent orchestration

For each invocation, the extension:

1. verifies that parent pi is inside tmux;
2. discovers and validates agent definitions;
3. validates the complete single or parallel request;
4. discovers existing managed panes and verifies window ownership;
5. plans safe evictions and pane capacity;
6. creates one run directory and manifest per child;
7. writes `task.md`, `system-prompt.md`, initial metadata, and status;
8. creates and tags the required right-side panes;
9. starts the Bun wrapper in each pane;
10. restores focus to the parent pane;
11. waits on unique tmux wait channels concurrently; and
12. reads and returns terminal statuses in request order.

If validation fails, no pane or partial batch is created. All run directories and panes for a batch are prepared before launching wrappers. If setup or launch fails, the extension performs a best-effort rollback of every newly created pane in that request, records infrastructure failures in the affected run directories, and signals their wait channels. It does not leave a deliberately partial parallel batch running.

### 11.2 Wrapper invocation

Each pane runs:

```text
bun run <package-path>/wrapper/run-child.ts <run-directory>/run.json
```

The wrapper uses `Bun.spawn` with an argument array, never shell interpolation, to launch a command equivalent to:

```text
pi -p --no-session \
  --model <model> \
  --thinking <thinking> \
  --tools <comma-separated-tools> \
  --append-system-prompt <system-prompt.md> \
  <task contents>
```

Optional flags are omitted when absent from the agent definition.

The child environment includes:

```text
PI_SUBAGENT_CHILD=1
```

When this variable is present, the extension does not register `subagent`, `/subagents`, or `/subagent-kill` in the child process.

### 11.3 Wrapper behavior

The wrapper:

1. decodes and validates `run.json`;
2. atomically writes `RUNNING` to `status.json`;
3. launches pi;
4. streams stdout to both the pane and `stdout.log`;
5. streams stderr to both the pane and `stderr.log`;
6. waits for pi to exit;
7. parses and validates the final status block;
8. atomically writes the terminal status;
9. emits a compact final pane footer; and
10. signals the run’s unique tmux wait channel in a finalizer.

Status files are written to a temporary sibling and renamed so readers never observe partial JSON.

### 11.4 Waiting semantics

The parent uses a unique `tmux wait-for` channel per run as the primary completion signal. The wrapper signals its channel from an Effect finalizer.

A low-frequency watchdog runs alongside each wait. It periodically reads `status.json` and checks that a `RUNNING` run still has its tagged pane. This prevents an indefinite wait if a signal is lost, the wrapper is force-killed, or the pane is closed manually. A terminal status releases the wait. A vanished pane with a still-`RUNNING` status is atomically changed to `FAILED` and also releases the wait.

After either path wakes, the parent treats `status.json` as authoritative. Cancelling the parent wait interrupts both the local wait subprocess and watchdog but does not signal or kill the child pane.

## 12. Effect architecture

The extension and wrapper are TypeScript programs built on Effect. Promise-based pi extension callbacks are boundary adapters only; domain and orchestration logic return `Effect` values.

### 12.1 Core schemas

Effect Schema defines and decodes:

- agent frontmatter;
- tool single and parallel inputs;
- run manifests;
- status blocks;
- `status.json`; and
- pane metadata returned from tmux.

Schema errors are converted into concise path-aware user messages.

### 12.2 Services

The implementation uses small services with live and test layers:

- `AgentRegistry` — discovers and decodes global definitions;
- `PaneService` — queries, creates, tags, lays out, waits for, and closes panes;
- `RunStore` — creates run directories and atomically reads/writes manifests and statuses;
- `ProcessService` — launches pi and wait commands;
- `FileSystemService` — filesystem operations;
- `ClockService` — timestamps and eviction ordering; and
- `IdService` — unique run IDs and wait-channel names.

Service interfaces describe capabilities rather than exposing subprocess details to orchestration code.

### 12.3 Concurrency and resource safety

- Parallel child setup and waits use bounded Effect concurrency with a hard maximum of three.
- Validation and capacity planning occur before concurrent side effects.
- Acquired wait processes and temporary resources use scoped Effect finalizers.
- Child pane processes are deliberately not scoped to the parent tool call because they must survive cancellation and parent restart.
- Extension runtime resources are disposed during pi session shutdown without terminating managed child panes.

### 12.4 Error model

Tagged errors distinguish at least:

- unavailable tmux context;
- invalid or duplicate agent definitions;
- invalid tool input;
- writer-policy violation;
- pane-capacity exhaustion;
- unmanaged-window conflict;
- pane command failure;
- run-store failure;
- child-process failure; and
- malformed child status.

Errors are rendered once at the pi boundary. Expected validation failures do not create partial panes or runs.

## 13. Suggested source structure

```text
src/
  index.ts
  agents.ts
  panes.ts
  runs.ts
  tool.ts
  commands.ts
  schemas.ts
  errors.ts
  services/
    agent-registry.ts
    pane-service.ts
    run-store.ts
    process-service.ts
    filesystem.ts
    clock.ts
    ids.ts
    runtime.ts
wrapper/
  run-child.ts
tests/
  fixtures/
```

The wrapper remains TypeScript because Bun executes TypeScript directly. No separate JavaScript wrapper or compilation exception is needed.

The package does not ship example agents. The README documents the frontmatter schema and status contract; tests contain only the minimal fixtures needed for validation.

## 14. Testing strategy

Tests require no model credentials or real API calls.

### 14.1 Unit tests

Cover:

- valid agent decoding;
- required fields and all thinking values;
- tools parsing and `writer: false` default;
- duplicate and malformed agent rejection;
- single versus parallel input exclusivity;
- one-to-three parallel task bounds;
- missing working directories;
- writer exclusivity with and without override;
- existing-running-writer checks;
- capacity planning across a whole batch;
- oldest-`DONE` eviction ordering;
- protection of every non-`DONE` status;
- exact end-anchored status-block parsing;
- `REPORT: NONE` and absolute report paths;
- nonzero child exit handling;
- malformed or missing status handling;
- atomic status-file writes;
- pane metadata decoding;
- pane discovery for the current parent;
- unmanaged-pane conflict detection;
- command construction without shell interpolation;
- parent wait cancellation without child termination;
- watchdog recovery from a lost signal or manually closed pane;
- `/subagents` rendering; and
- exact and all-run kill behavior.

### 14.2 Integration tests with service layers

Use test layers for filesystem, process, pane, clock, and ID services to verify:

- one successful child;
- three parallel non-writers;
- rejection of parallel writers;
- explicit parallel-writer override;
- one writer alongside non-writers;
- failed and blocked child retention;
- safe completed-pane eviction;
- atomic rejection when a parallel batch cannot fit;
- wrapper terminal-status generation;
- wrapper finalizer signaling;
- rollback of a partially failed batch setup or launch;
- extension reconstruction from tagged panes after runtime recreation; and
- parent shutdown leaving children untouched.

### 14.3 Real-tmux tests

When tmux is available, run a smaller suite against an isolated tmux server and a fake `pi` executable:

- create the parent-left/right-stack layout;
- verify equal child stacking and focus restoration;
- enforce the three-pane limit;
- retain exited panes;
- evict the oldest `DONE` pane;
- preserve protected panes;
- leave children running after the parent process exits;
- recreate the extension and rediscover tagged panes in the same parent pane; and
- explicitly clean up all managed panes.

Tests must isolate their tmux socket and temporary home directory so they cannot alter a developer’s real session or global agents.

## 15. Security and operational constraints

- Agent definitions are global and user-controlled; project repositories cannot inject agent prompts.
- All subprocesses use argument arrays rather than interpolated shell commands.
- Run IDs, paths, and pane metadata are schema-validated before use.
- The extension never closes an untagged pane.
- The extension never rearranges a window containing unrelated panes.
- Nested delegation is disabled in child processes.
- Parallel writers require an explicit per-call override.
- Run logs may contain sensitive source or prompt content and should inherit user-only filesystem permissions.

## 16. SDD compatibility summary

The extension supplies the process-management primitives SDD needs without implementing SDD itself:

- fresh one-shot child per dispatch;
- explicit model, thinking level, and tools from agent definitions;
- implementer/writer exclusivity by default;
- parallel read-only scouting or review up to three children;
- durable task and report paths;
- deterministic `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, and `BLOCKED` outcomes;
- visible child progress;
- parent-controlled sequencing and review loops; and
- pane survival across parent pi reload or restart in the same tmux pane.

This boundary keeps the extension lightweight while allowing Superpowers to remain the workflow controller.
