# Subagents

## Purpose

The Subagents extension provides one `subagent` tool for running isolated, ephemeral Pi CLI children. It is a process-execution primitive: Superpowers and other callers own task briefs, roles, sequencing, reviews, reports, commits, worktrees, and acceptance gates.

[Extensions](./extensions.md) owns extension discovery and runtime dependency policy. [Process Service](./process-service.md) owns scoped child-process lifecycle and bounded cleanup.

## Tool Contract

A request contains a non-empty `tasks` array with no fixed maximum. Every task has a non-whitespace `description`, a non-whitespace `prompt`, and an optional `cwd`. Unknown request and task fields are rejected.

Accepted descriptions and prompts are not trimmed or rewritten. The description labels parent-facing progress and results and is not sent to the child. A missing `cwd` uses the parent tool context's working directory; a relative value resolves from that directory. An invalid resolved directory fails only that task.

Callers cannot select agents, models, thinking levels, tools, concurrency, output modes, retries, or timeouts.

## Parent Inheritance and Child Isolation

At the beginning of each call, the extension snapshots the active parent model's provider and identifier and Pi's current effective thinking level. Every queued and running task in that call uses the same snapshot. A missing active model is a tool-level error.

Each task starts a fresh Pi process in text print mode with no session. The child receives the inherited model and thinking level and exactly the built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools. Extensions, skills, and prompt templates are disabled. Normal project context-file discovery remains enabled, and Pi's stock system prompt is not replaced or appended.

The extension reuses the current Pi executable or script when it is reusable and otherwise invokes `pi` from `PATH`. Commands use argument arrays without shell interpolation. A model supplied only by an extension-registered provider may therefore be unavailable to the isolated child and fail normally.

The accepted prompt is written once and unchanged to child standard input, followed by a confirmed EOF request. It is never placed in process arguments or an extension-owned file.

## Scheduling and Execution

One loaded extension instance owns three global permits across all overlapping `subagent` calls. Each call starts at most three task effects concurrently, and excess tasks wait in memory. Permit waiting is interruptible, and scoped ownership prevents cancellation from leaking capacity.

Every task's effective working directory is resolved from the parent context before the batch starts. A started task acquires a global permit and launches a fresh child through the shared Process Service. Standard output, standard error, and terminal exit are observed concurrently. A permit remains held through scoped process cleanup.

A task failure does not cancel siblings, and queued tasks continue when permits become available. Results remain in request order even when children settle out of order. The call returns only after every task settles unless the parent cancels it or the session shuts down.

The extension adds no retry or execution timeout. Pi's stock provider retry behavior inside a child remains unchanged, but the extension never relaunches the child.

## Progress

When an update callback is available, the extension publishes `0/N` before execution and a synchronized completed-task count after every settlement. Updates contain only the count and never expose prompts, child reasoning, partial assistant text, or tool calls. A throwing update callback is ignored.

## Results and Errors

Every ordered task result contains its description, resolved absolute working directory, `completed` or `failed` status, nullable exit code, nullable signal, and bounded standard output. Bounded standard error is optional structured detail.

A task is completed only after confirmed stdin EOF, successful output drains, and process exit with code zero and no signal. Invalid working directories, spawn failures, stdin failures, stream failures, wait failures, nonzero exits, and signals produce failed task results without failing the batch. Known exit and signal values are preserved. Empty standard output is valid and represented explicitly.

Malformed input, blank required text, a missing active parent model, and runtime-state initialization failure are tool-level errors and start no child.

Model-facing content begins with compact ordered statuses and then ordered task sections. Successful sections omit standard error; failed sections include retained diagnostics. Child prose remains opaque and does not determine semantic success or failure.

## Output Safety and Bounds

Both child streams continue draining after retained output reaches its limit. Standard output retains at most its first 50 KiB and 2,000 lines per task. Standard error retains at most its final 50 KiB and 2,000 lines per task.

Displayed text removes terminal-active sequences and unsafe controls while preserving ordinary text, tabs, and normalized line breaks. The complete model-facing result also stays within 50 KiB and 2,000 lines. Statuses and later task labels receive reserved space before remaining capacity is shared across ordered task outputs. Explicit omission markers report per-task, aggregate-output, or task-status truncation. Structured details retain only already-bounded task data and do not bypass the aggregate model-facing limit.

Callers that require complete durable output must instruct children to write workflow-owned report files.

## Cancellation and Shutdown

The Pi tool's abort signal interrupts tasks waiting for permits and all running task scopes for that invocation. Cancellation rejects the tool call rather than synthesizing failed task results.

Leaving a running scope uses the [Process Service](./process-service.md) EOF, `SIGTERM`, `SIGKILL`, and total-deadline cleanup contract. On `session_shutdown`, the extension idempotently disposes its managed runtime, interrupts all remaining invocation fibers, and waits for scoped cleanup. The extension starts no process during factory initialization or session start.

## Non-goals

The extension does not provide named agents, custom child system prompts, child-selectable capabilities, pipelines, background runs, resume or status commands, persistent state, extension-owned logs or reports, workflow orchestration, semantic completion parsing, nested subagents, extension-level retries, or execution timeouts.
