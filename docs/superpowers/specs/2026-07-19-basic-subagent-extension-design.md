# Basic Subagent Extension Design

**Date:** 2026-07-19
**Status:** Approved
**Base:** `main`

## 1. Purpose

Add the smallest Pi extension that supplies the fresh-agent dispatch primitive expected by Superpowers' Subagent-Driven Development workflow.

The extension runs isolated, ephemeral Pi CLI children. Superpowers remains responsible for task briefs, role instructions, implementation and review sequencing, report files, status conventions, worktrees, commits, and acceptance gates.

This design intentionally does not port the unreleased execution engine from `feat/pi-subagents`. It starts from the current `main` contracts and keeps only the behavior approved here.

## 2. Goals

- Register one parent-facing `subagent` tool.
- Run any non-empty batch of tasks.
- Limit the extension to three live child processes globally while queueing additional tasks in memory.
- Give each task a fresh Pi process and context window.
- Inherit the active parent model and thinking level without exposing either as tool input.
- Give children only Pi's seven built-in coding tools.
- Disable extension, skill, and prompt-template loading in children.
- Preserve normal project context-file discovery.
- Pass each delegated prompt unchanged as the child's user message.
- Return coarse progress and ordered, bounded final results.
- Reuse the repository's Effect runtime and scoped Process Service.

## 3. Non-goals

The first version does not provide:

- named or configurable agent definitions;
- child-selectable model, thinking, tools, or concurrency;
- extension tools or custom provider extensions in children;
- skills or prompt templates in children;
- child-specific system prompts;
- chains, pipelines, background execution, resume, or status commands;
- persistent run state, logs, manifests, or extension-owned report files;
- structured semantic completion or parsing of child prose;
- extension-level retries or execution timeouts;
- live child reasoning, assistant text, or tool-call streaming;
- worktree, commit, review, or report orchestration; or
- nested subagent delegation.

Pi's own stock provider-retry behavior is not replaced. The extension does not relaunch a child or retry a failed task.

## 4. Public tool contract

The extension registers `subagent` with one strict input shape:

```ts
interface SubagentRequest {
  readonly tasks: ReadonlyArray<{
    readonly description: string;
    readonly prompt: string;
    readonly cwd?: string;
  }>;
}
```

`tasks` must contain at least one item and has no fixed maximum. Each `description` and `prompt` must contain non-whitespace text. Validation does not trim or otherwise rewrite accepted prompts.

`description` is parent-facing metadata used in progress and result labels. It is not sent to the child.

`cwd` defaults to the parent extension context's working directory. A relative value resolves from that parent directory. A missing or invalid resolved directory becomes that task's execution failure and does not cancel siblings.

The schema exposes no `agent`, `model`, `thinking`, `tools`, `concurrency`, `output`, `timeout`, or retry fields. Unknown fields are rejected rather than ignored.

## 5. Parent inheritance

At the beginning of each tool call, the extension snapshots:

- the active parent model's provider and identifier; and
- Pi's current effective thinking level.

Every task in that call uses the same snapshot. A later parent model or thinking change does not affect already queued or running tasks.

The extension translates the snapshot into internal child CLI arguments. Callers cannot override it.

If the inherited model exists only through an extension-registered provider, disabling child extensions may make that model unavailable in the child. In that case the task fails normally; the extension does not load the provider extension because the child-isolation contract takes precedence.

## 6. Child invocation

Each task launches a fresh Pi CLI process in text print mode. The effective invocation includes:

```text
--mode text
--print
--no-session
--model <parent-provider>/<parent-model>
--thinking <parent-thinking>
--tools read,bash,edit,write,grep,find,ls
--no-extensions
--no-skills
--no-prompt-templates
```

The extension does not pass `--no-context-files`, so normal `AGENTS.md` and other Pi context-file discovery remains active for the child working directory.

The extension does not pass a replacement or appended system prompt. Pi's stock system prompt remains authoritative.

The command resolver follows the current Pi process when it has a reusable executable or script path and otherwise falls back to `pi` on `PATH`. Child execution always uses an argument array and never an interpolated shell command.

The delegated prompt is written unchanged to child standard input and then EOF is requested. It is not placed in process arguments or copied to an extension-owned file. This avoids command-line length limits and exposure through process listings.

## 7. Architecture

Production code is split into focused units under `src/subagents/`:

- `index.ts` owns Pi registration, TypeBox input, parent snapshots, the shared semaphore, progress callbacks, Effect runtime bridging, and session shutdown.
- `child-command.ts` owns pure construction of the Pi command and fixed arguments.
- `execution.ts` owns cwd resolution, permit acquisition, scoped process execution, concurrent stream draining, task outcomes, and ordered batch execution.
- `output.ts` owns bounded stream accumulation, terminal-safe text, progress formatting, and final result formatting.

Only `index.ts` is listed in `package.json` as an extension entrypoint.

The extension uses the shared `ProcessService` and an Effect runtime layer. It does not expose Node child-process objects or introduce a second process abstraction.

The shared semaphore is runtime-only state. It has three permits across every concurrent `subagent` invocation in the loaded extension instance. Waiting for a permit is interruptible, and permit ownership is scoped so interruption cannot leak capacity.

## 8. Execution flow

For each tool call, the extension:

1. validates the complete input;
2. snapshots parent model and thinking state;
3. resolves every task's effective working directory;
4. starts at most three ordered task effects concurrently within the call;
5. lets each started task acquire one permit from the global three-permit semaphore;
6. spawns a fresh child through `ProcessService.spawnScoped`;
7. writes the prompt to stdin and confirms EOF;
8. drains stdout and stderr concurrently while waiting for process exit;
9. classifies the task outcome;
10. releases the permit through scope finalization;
11. publishes a coarse completion-count update; and
12. returns all task results in request order.

A child failure never cancels its siblings. Queued tasks continue as permits become available.

No extension-level result is returned until every task has settled, unless the parent cancels the tool call or the session shuts down.

## 9. Progress

Progress is intentionally coarse. When Pi provides an update callback, the extension reports `0/N` before execution and publishes the synchronized count after every task settles:

```text
Subagents: 2/5 completed
```

It does not decode child output into assistant messages or tool-call activity. Updates contain no delegated prompt or partial child response.

A throwing progress callback is ignored and cannot fail or delay child execution.

## 10. Result contract

Each structured task result contains:

```ts
interface SubagentTaskResult {
  readonly description: string;
  readonly cwd: string;
  readonly status: "completed" | "failed";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly stderr?: string;
}
```

A task is `completed` only when the process exits with code zero and no signal after its output streams drain successfully. Empty stdout is allowed and represented explicitly.

A task is `failed` for cwd or spawn failure, stdin failure, output-stream failure, nonzero exit, or signal termination. Failure output includes bounded stdout when available and bounded stderr. Successful model-facing output omits stderr.

The model-facing result begins with a compact ordered status list, followed by ordered task outputs. Results preserve request order even when children finish out of order.

The extension treats child prose as opaque text. Superpowers prompts remain responsible for statuses such as `DONE`, report paths, required headings, and short return formats. The parent reads and validates workflow-owned report files separately.

## 11. Output safety and bounds

All child streams are drained even after retained output reaches its limit, preventing a full pipe from blocking process exit.

Retained stdout keeps at most the first 50 KB and 2,000 lines per task; retained stderr keeps at most the final 50 KB and 2,000 lines. Both streams continue draining after those bounds. Text shown in the parent is stripped of terminal-active sequences and unsafe control characters while preserving ordinary text, tabs, and line breaks. No unbounded raw copy is retained elsewhere.

The final tool content respects Pi's normal 50 KB and 2,000-line limits. Formatting reserves space for compact task statuses before sharing the remaining budget across ordered task outputs. One unusually large response therefore cannot consume the complete budget and hide every later task.

When the task count or child output cannot fit, the result states that content was omitted. Structured details retain each task's bounded result but do not bypass the model-facing aggregate limit.

Because the API intentionally has no batch-size maximum, sufficiently large batches cannot expose every child response in full. Callers that need complete durable output must instruct children to write workflow-owned report files.

## 12. Cancellation and shutdown

The Pi tool's `AbortSignal` is passed to Effect execution. Cancellation interrupts queued tasks and all running task scopes.

Leaving a running task scope invokes the existing Process Service shutdown sequence: allow up to 100 ms for stdin EOF, request `SIGTERM` and wait up to one second, request `SIGKILL` and wait up to one second, and enforce a 2.1-second total cleanup deadline. If terminal exit remains unconfirmed, cleanup releases local process handles.

Cancellation aborts the tool call rather than synthesizing ordinary failed task results. The extension does not retain a cancellation status after the call ends.

On `session_shutdown`, the extension disposes its managed runtime. Disposal is idempotent and interrupts remaining work so scoped child cleanup can run. The extension starts no process from its factory or session-start handler.

## 13. Error boundaries

Errors divide into two classes:

- **Tool-level errors:** malformed input, blank required text, missing active parent model, or failure to initialize extension runtime state. No child starts for these errors.
- **Task-level failures:** invalid cwd, child spawn or I/O failure, unsuccessful exit, or child signal. These are ordered results and do not fail the batch.

The extension does not infer semantic failure from child prose and does not infer semantic success beyond a clean process exit.

## 14. Testing

Tests require no model credentials or provider calls.

### Public boundary

- register exactly one `subagent` tool;
- require a non-empty task array;
- reject blank descriptions and prompts;
- reject unknown and forbidden configuration fields;
- prove accepted prompts are not trimmed or rewritten; and
- dispose runtime state on session shutdown.

### Command construction

- pass the exact seven built-in tool names;
- pass inherited model and thinking internally;
- include print, text, and ephemeral-session flags;
- disable extensions, skills, and prompt templates;
- omit context-file disabling and all system-prompt overrides;
- avoid shell interpolation; and
- cover reusable-current-process and `pi` fallback resolution.

### Execution

- deliver exact prompt bytes through stdin;
- resolve default and relative working directories;
- return one successful child;
- preserve request order across out-of-order completion;
- continue siblings after spawn, stream, and exit failures;
- enforce three live children across overlapping tool calls;
- queue and later start additional tasks;
- interrupt queued tasks cleanly;
- trigger scoped process shutdown for running-task cancellation; and
- ignore progress callback failures.

### Output

- render ordered mixed outcomes;
- expose stderr only for failures in model-facing content;
- bound retained output and continue draining discarded bytes;
- preserve status visibility under fair aggregate truncation;
- enforce the 50 KB and 2,000-line aggregate limits; and
- remove ANSI, OSC, and unsafe control sequences.

A fake child executable exercises real stdin, stdout, stderr, delays, exit codes, signals, and concurrent process counting through the live Process Service.

Repository validation runs `bun run check`, package-manifest coverage, isolated global linking, and a Pi extension-load smoke test.

## 15. Living specification impact

Implementation adds `docs/specs/subagents.md` as the owner of the tool, child-isolation, concurrency, execution, progress, result, and cancellation contracts.

`docs/specs/index.md` adds the new specification. `docs/specs/extensions.md` and `package.json` add the extension entrypoint.

The existing Process Service specification remains accurate because this extension consumes its current scoped-spawn and bounded-cleanup contract without changing it. Internal cancellation plumbing in the shared Effect runner does not add a separate user-visible process contract.

## 16. Acceptance criteria

The design is complete when a parent Pi agent can call `subagent` with one or more tasks and observe:

- no more than three child Pi processes live at once;
- each child using the parent model and thinking level;
- exactly the seven built-in tools and no extension tools;
- no extension, skill, or prompt-template loading;
- normal project context files;
- an unchanged delegated user prompt;
- coarse progress only;
- ordered mixed results; and
- bounded cancellation and session-shutdown cleanup.

The resulting extension must remain a process-execution primitive. Superpowers continues to define and enforce the SDD workflow above it.
