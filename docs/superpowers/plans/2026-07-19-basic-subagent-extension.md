# Basic Subagent Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one `subagent` extension tool that runs fresh, isolated Pi CLI children with inherited parent model/thinking, a global concurrency limit of three, ordered bounded results, and interruption-safe cleanup.

**Architecture:** Four focused modules under `src/subagents/` separate Pi registration/runtime ownership, pure child-command construction, scoped Process Service execution, and terminal-safe bounded output. A scoped Effect runtime state owns the shared semaphore and a work scope so both tool cancellation and `session_shutdown` interrupt queued/running batches while preserving the existing Process Service cleanup contract.

**Tech Stack:** TypeScript 6, Bun 1.3, Effect 3.22, Pi extension API 0.80.7, TypeBox through `@earendil-works/pi-ai`, Vitest 3

## Global Constraints

- Work from the isolated `feat/basic-subagent-extension` worktree that contains the approved design; do not create another worktree.
- Use Bun for dependency, test, formatting, linking, and validation commands.
- Register exactly one parent-facing tool named `subagent`.
- Accept any non-empty task array; do not add a batch-size maximum.
- Permit at most three live child processes across all overlapping calls in one loaded extension instance.
- Snapshot one parent `provider`, model `id`, and effective thinking level at the beginning of each call; callers cannot override them.
- Invoke each child with `--mode text --print --no-session`, the inherited model/thinking, and exactly `read,bash,edit,write,grep,find,ls`.
- Disable child extensions, skills, and prompt templates; preserve normal context-file discovery and Pi's stock system prompt.
- Write each accepted prompt once, unchanged and without an added newline, to child stdin; then await confirmed EOF.
- Do not add extension-level retries, timeouts, persistence, report files, semantic output parsing, nested delegation, or workflow orchestration.
- Retain stdout from the head and stderr from the tail, each capped at 50 KiB and 2,000 lines while continuing to drain both streams.
- Keep final model-facing content at or below 50 KiB and 2,000 lines, with ordered statuses and fair space for later task labels/results.
- Use `ProcessService.spawnScoped` and its exact cleanup policy: 100 ms stdin close, 1 second `SIGTERM`, 1 second `SIGKILL`, and a 2.1-second total deadline.
- Cancellation aborts the tool call; it is not converted into an ordinary task result.
- Use Effect services, scopes, fibers, `Ref`, and semaphores for runtime state and concurrency.
- Do not change `src/services/process.ts` or `docs/specs/process-service.md`; this feature consumes their existing contract.
- Do not edit `.context`. Use it only to confirm Pi and Effect APIs.
- Avoid unsafe type assertions and non-null assertions.
- Add the living subagent specification in the same task that publishes the manifest entrypoint.
- At this repository boundary, unchanged prompt delivery means the exact string reaches `ManagedProcess.writeStdin`. Pi 0.80.7 currently trims piped stdin after receipt; do not compensate with wrapper bytes, positional arguments, a prompt file, a system prompt, or a `.context` edit. Preserve exact extension-side delivery and record that upstream limitation in the implementation handoff if it remains.

---

## File Map and Dependency Order

| File                              | Responsibility                                                                           | Depends on                            |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| `src/lib/effect-runtime.ts`       | Forward caller cancellation into ManagedRuntime                                          | Existing Effect runtime               |
| `src/subagents/child-command.ts`  | Pure fixed argv and current-Pi command resolution                                        | Parent snapshot                       |
| `src/subagents/output.ts`         | Stateful terminal sanitization, bounded capture, progress/final formatting, result types | Pi output constants                   |
| `src/subagents/execution.ts`      | Cwd resolution, scoped child lifecycle, global permits, ordered batch execution          | Child command and output contracts    |
| `src/subagents/index.ts`          | Strict tool schema, parent snapshot, runtime state/work scope, Pi registration, shutdown | Execution and output                  |
| `test/fixtures/subagent-child.ts` | Credential-free live Process Service fixture                                             | Bun and Effect Schema; no Pi/provider |
| `docs/specs/subagents.md`         | Living behavioral contract                                                               | Extensions and Process Service specs  |

Tasks 2 and 3 are independent after Task 1. Task 4 consumes both. Task 5 consumes Tasks 1–4. Task 6 is the publication gate.

---

### Task 1: Forward AbortSignal through the shared Effect runner

**Files:**

- Modify: `src/lib/effect-runtime.ts:1-20`
- Test: `src/lib/effect-runtime.test.ts`

**Interfaces:**

- Consumes: `ManagedRuntime.runPromise(effect, { signal?: AbortSignal })`.
- Produces: `runner.runPromise(effect, options?)` with the same optional signal contract; existing one-argument callers remain source-compatible.

- [ ] **Step 1: Add a failing cancellation regression test**

Append this case to `src/lib/effect-runtime.test.ts`:

```ts
it("forwards AbortSignal and runs interruption finalizers", async () => {
  const runner = makeEffectRunner(Layer.empty);
  const started = Promise.withResolvers<void>();
  let finalizations = 0;
  const controller = new AbortController();

  const running = runner.runPromise(
    Effect.sync(() => started.resolve()).pipe(
      Effect.zipRight(Effect.sleep("50 millis")),
      Effect.as("finished"),
      Effect.ensuring(
        Effect.sync(() => {
          finalizations += 1;
        }),
      ),
    ),
    { signal: controller.signal },
  );

  await started.promise;
  controller.abort();

  await expect(running).rejects.toThrow();
  expect(finalizations).toBe(1);
  await runner.dispose();
});
```

- [ ] **Step 2: Run the focused test to verify RED**

```bash
bun --bun vitest run src/lib/effect-runtime.test.ts --reporter verbose
```

Expected: the new test fails because the wrapper ignores the second argument and the effect resolves as `"finished"` instead of being interrupted.

- [ ] **Step 3: Forward the optional runtime options**

Change the returned `runPromise` member in `src/lib/effect-runtime.ts` to:

```ts
runPromise: <A, E2>(
  effect: Effect.Effect<A, E2, R>,
  options?: { readonly signal?: AbortSignal },
): Promise<A> => runtime.runPromise(effect, options),
```

Do not change `runFork` or the memoized, idempotent `dispose` implementation.

- [ ] **Step 4: Run focused and static validation**

```bash
bun --bun vitest run src/lib/effect-runtime.test.ts --reporter verbose
bun typecheck
bunx prettier --check src/lib/effect-runtime.ts src/lib/effect-runtime.test.ts
git diff --check
```

Expected: both runtime tests pass, TypeScript accepts existing callers, and formatting/whitespace checks succeed.

- [ ] **Step 5: Commit the cancellation bridge**

```bash
git add src/lib/effect-runtime.ts src/lib/effect-runtime.test.ts
git commit -m "refactor(effect): forward cancellation signals"
```

Expected: one commit containing only the runner and its regression test.

---

### Task 2: Construct the isolated Pi child command

**Files:**

- Create: `src/subagents/child-command.ts`
- Test: `src/subagents/child-command.test.ts`

**Interfaces:**

- Consumes: `ParentSnapshot { provider: string; modelId: string; thinkingLevel: string }` and injectable current-process facts.
- Produces: `ChildCommand { command: string; args: ReadonlyArray<string> }` through `buildChildCommand(snapshot, processInfo?)`.

- [ ] **Step 1: Write failing resolver and argv tests**

Create `src/subagents/child-command.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildChildCommand,
  type CurrentProcessInfo,
  type ParentSnapshot,
} from "./child-command";

const snapshot: ParentSnapshot = {
  provider: "openai-codex",
  modelId: "gpt-5.4",
  thinkingLevel: "high",
};

const processInfo = (
  overrides: Partial<CurrentProcessInfo> = {},
): CurrentProcessInfo => ({
  execPath: "/usr/bin/node",
  scriptPath: "/opt/pi/dist/cli.js",
  scriptExists: () => true,
  ...overrides,
});

describe("buildChildCommand", () => {
  it("builds the exact isolated child arguments", () => {
    const command = buildChildCommand(snapshot, processInfo());

    expect(command).toEqual({
      command: "/usr/bin/node",
      args: [
        "/opt/pi/dist/cli.js",
        "--mode",
        "text",
        "--print",
        "--no-session",
        "--model",
        "openai-codex/gpt-5.4",
        "--thinking",
        "high",
        "--tools",
        "read,bash,edit,write,grep,find,ls",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
      ],
    });
    expect(command.args).not.toContain("--no-context-files");
    expect(command.args).not.toContain("--system-prompt");
    expect(command.args).not.toContain("--append-system-prompt");
  });

  it("uses a packaged Pi executable without a script prefix", () => {
    expect(
      buildChildCommand(
        snapshot,
        processInfo({
          execPath: "/opt/pi/bin/pi",
          scriptPath: undefined,
          scriptExists: () => false,
        }),
      ).command,
    ).toBe("/opt/pi/bin/pi");
  });

  it("falls back to pi for generic runtimes without a reusable script", () => {
    const missing = buildChildCommand(
      snapshot,
      processInfo({ scriptExists: () => false }),
    );
    const virtual = buildChildCommand(
      snapshot,
      processInfo({ scriptPath: "/$bunfs/root/pi" }),
    );

    expect(missing.command).toBe("pi");
    expect(virtual.command).toBe("pi");
    expect(missing.args[0]).toBe("--mode");
    expect(virtual.args[0]).toBe("--mode");
  });

  it("passes extension-only provider names through without weakening isolation", () => {
    const command = buildChildCommand(
      { ...snapshot, provider: "extension-only-provider" },
      processInfo(),
    );

    expect(command.args).toContain(
      "extension-only-provider/" + snapshot.modelId,
    );
    expect(command.args).toContain("--no-extensions");
  });
});
```

- [ ] **Step 2: Run the command tests to verify RED**

```bash
bun --bun vitest run src/subagents/child-command.test.ts --reporter verbose
```

Expected: FAIL because `./child-command` does not exist.

- [ ] **Step 3: Add the pure command builder and live process adapter**

Create `src/subagents/child-command.ts`:

```ts
import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface ParentSnapshot {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
}

export interface ChildCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface CurrentProcessInfo {
  readonly execPath: string;
  readonly scriptPath?: string;
  readonly scriptExists: (path: string) => boolean;
}

const liveProcessInfo = (): CurrentProcessInfo => ({
  execPath: process.execPath,
  ...(process.argv[1] === undefined ? {} : { scriptPath: process.argv[1] }),
  scriptExists: existsSync,
});

const fixedArgs = (snapshot: ParentSnapshot): ReadonlyArray<string> => [
  "--mode",
  "text",
  "--print",
  "--no-session",
  "--model",
  snapshot.provider + "/" + snapshot.modelId,
  "--thinking",
  snapshot.thinkingLevel,
  "--tools",
  "read,bash,edit,write,grep,find,ls",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
];

export const buildChildCommand = (
  snapshot: ParentSnapshot,
  current: CurrentProcessInfo = liveProcessInfo(),
): ChildCommand => {
  const args = fixedArgs(snapshot);
  const script = current.scriptPath;
  const reusableScript =
    script !== undefined &&
    !script.startsWith("/$bunfs/root/") &&
    current.scriptExists(script);

  if (reusableScript) {
    return { command: current.execPath, args: [script, ...args] };
  }

  const executable = basename(current.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: current.execPath, args };
  }

  return { command: "pi", args };
};
```

The prompt must not appear in `ParentSnapshot`, `ChildCommand`, or argv.

- [ ] **Step 4: Run focused validation**

```bash
bun --bun vitest run src/subagents/child-command.test.ts --reporter verbose
bunx prettier --check src/subagents/child-command.ts src/subagents/child-command.test.ts
bun typecheck
git diff --check
```

Expected: all resolver/argument tests pass, including virtual-script and PATH fallback cases.

- [ ] **Step 5: Commit the command boundary**

```bash
git add src/subagents/child-command.ts src/subagents/child-command.test.ts
git commit -m "feat(subagents): construct isolated child command"
```

---

### Task 3: Bound, sanitize, and fairly format child output

**Files:**

- Create: `src/subagents/output.ts`
- Test: `src/subagents/output.test.ts`

**Interfaces:**

- Consumes: decoded stdout lines, decoded stderr chunks, and ordered task results.
- Produces `SubagentTaskResult`, `makeHeadAccumulator()`, `makeTailAccumulator()`, `formatProgress(completed, total)`, and `formatSubagentResults(results, limits?)`.

- [ ] **Step 1: Write failing sanitization and retention tests**

Create `src/subagents/output.test.ts` with small injected limits:

```ts
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  formatProgress,
  formatSubagentResults,
  makeHeadAccumulator,
  makeTailAccumulator,
  sanitizeTerminalText,
  type SubagentTaskResult,
} from "./output";

const completed = (
  description: string,
  output: string,
): SubagentTaskResult => ({
  description,
  cwd: "/repo",
  status: "completed",
  exitCode: 0,
  signal: null,
  output,
});

describe("subagent output safety", () => {
  it("removes split ANSI, OSC, DEL, C0, and C1 controls", () => {
    const head = makeHeadAccumulator({ maxBytes: 200, maxLines: 20 });
    head.append("\u001b]8;;https://unsafe.example");
    head.append("\u0007link\u001b]8;;\u001b\\ \u001b[31mred\u001b[0m");
    head.append("\u0000\u007f\u0090hidden\u009ctab\tline\n");
    head.finish();

    expect(head.snapshot()).toEqual({
      text: "link redtab\tline\n",
      truncated: false,
    });
    expect(sanitizeTerminalText("safe\u001b[31")).toBe("safe");
  });

  it("keeps stdout from the head and stderr from the tail", () => {
    const head = makeHeadAccumulator({ maxBytes: 32, maxLines: 2 });
    head.append("first\nsecond\nthird\n");
    head.finish();

    const tail = makeTailAccumulator({ maxBytes: 32, maxLines: 2 });
    tail.append("first\nsecond\nthird\n");
    tail.finish();

    expect(head.snapshot().text).toContain("first");
    expect(head.snapshot().text).not.toContain("third");
    expect(tail.snapshot().text).toContain("third");
    expect(tail.snapshot().text).not.toContain("first");
    expect(head.snapshot().truncated).toBe(true);
    expect(tail.snapshot().truncated).toBe(true);
    expect(Buffer.byteLength(head.snapshot().text, "utf8")).toBeLessThanOrEqual(
      32,
    );
    expect(Buffer.byteLength(tail.snapshot().text, "utf8")).toBeLessThanOrEqual(
      32,
    );
  });

  it("does not split multi-byte characters at byte boundaries", () => {
    const head = makeHeadAccumulator({ maxBytes: 17, maxLines: 10 });
    head.append("ééééééééé");
    head.finish();
    expect(head.snapshot().text).not.toContain("�");
  });

  it("normalizes split CRLF and standalone carriage returns to LF", () => {
    const head = makeHeadAccumulator({ maxBytes: 200, maxLines: 20 });
    head.append("first\r");
    head.append("\nsecond\rthird");
    head.finish();

    expect(head.snapshot().text).toBe("first\nsecond\nthird");
    expect(head.snapshot().text).not.toContain("\r");
  });

  it("keeps omission markers inside tiny limits and rotates a truncated tail", () => {
    const head = makeHeadAccumulator({ maxBytes: 12, maxLines: 1 });
    head.append("abcdefghijklmnopqrstuvwxyz");
    head.finish();

    const tail = makeTailAccumulator({ maxBytes: 24, maxLines: 2 });
    tail.append("old-old-old-old\n");
    tail.append("middle-middle\n");
    tail.append("newest");
    tail.finish();

    expect(Buffer.byteLength(head.snapshot().text, "utf8")).toBeLessThanOrEqual(
      12,
    );
    expect(head.snapshot().text).toContain("omitted");
    expect(tail.snapshot().text).toContain("newest");
    expect(tail.snapshot().text).not.toContain("old-old");
  });

  it("formats exact coarse progress", () => {
    expect(formatProgress(0, 5)).toBe("Subagents: 0/5 completed");
    expect(formatProgress(5, 5)).toBe("Subagents: 5/5 completed");
  });
});
```

- [ ] **Step 2: Write failing ordered and aggregate-budget tests**

Add:

```ts
describe("formatSubagentResults", () => {
  it("renders ordered statuses and outputs, with stderr only for failures", () => {
    const results: ReadonlyArray<SubagentTaskResult> = [
      { ...completed("first", ""), stderr: "successful warning" },
      {
        description: "second",
        cwd: "/repo/two",
        status: "failed",
        exitCode: 7,
        signal: null,
        output: "partial",
        stderr: "boom",
      },
      {
        description: "third",
        cwd: "/repo/three",
        status: "failed",
        exitCode: null,
        signal: "SIGTERM",
        output: "",
      },
    ];

    const text = formatSubagentResults(results);
    expect(text.indexOf("1. completed — first")).toBeLessThan(
      text.indexOf("2. failed — second"),
    );
    expect(text.indexOf("[1] first")).toBeLessThan(text.indexOf("[3] third"));
    expect(text).toContain("(no stdout)");
    expect(text).toContain("boom");
    expect(text).toContain("(exit 7)");
    expect(text).toContain("(signal SIGTERM)");
    expect(text).not.toContain("successful warning");
  });

  it("prevents descriptions and cwd values from injecting aggregate lines", () => {
    const result = {
      ...completed("\u001b[31mfirst\nforged status", "safe"),
      cwd: "/repo\rforged cwd",
    };
    const text = formatSubagentResults([result]);

    expect(text).toContain("first forged status");
    expect(text).toContain("cwd: /repo forged cwd");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\r");
  });

  it("reserves status and label space before sharing aggregate output", () => {
    const results = [
      completed("first", "A".repeat(500)),
      completed("second", "B".repeat(500)),
      completed("third", "C".repeat(500)),
    ];
    const text = formatSubagentResults(results, {
      maxBytes: 300,
      maxLines: 30,
    });

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(300);
    expect(text.split("\n").length).toBeLessThanOrEqual(30);
    expect(text).toContain("1. completed — first");
    expect(text).toContain("3. completed — third");
    expect(text).toContain("[1] first");
    expect(text).toContain("[3] third");
    expect(text).toContain("omitted");
  });

  it("reports status omission when a huge task list consumes the budget", () => {
    const results = Array.from({ length: 100 }, (_, index) =>
      completed("task-" + String(index + 1), "done"),
    );
    const text = formatSubagentResults(results, {
      maxBytes: 180,
      maxLines: 8,
    });
    expect(text).toContain("task statuses omitted");
    expect(text).toContain("task output sections omitted");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(180);
  });
});
```

- [ ] **Step 3: Run output tests to verify RED**

```bash
bun --bun vitest run src/subagents/output.test.ts --reporter verbose
```

Expected: FAIL because `./output` does not exist.

- [ ] **Step 4: Implement terminal-safe bounded accumulation**

Create `src/subagents/output.ts` with:

```ts
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

export interface OutputLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

export interface BoundedSnapshot {
  readonly text: string;
  readonly truncated: boolean;
}

export interface BoundedAccumulator {
  readonly append: (chunk: string) => void;
  readonly finish: () => void;
  readonly snapshot: () => BoundedSnapshot;
}

export interface SubagentTaskResult {
  readonly description: string;
  readonly cwd: string;
  readonly status: "completed" | "failed";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly stderr?: string;
}

export const TASK_OUTPUT_LIMITS: OutputLimits = {
  maxBytes: DEFAULT_MAX_BYTES,
  maxLines: DEFAULT_MAX_LINES,
};

export const MODEL_OUTPUT_LIMITS: OutputLimits = {
  maxBytes: DEFAULT_MAX_BYTES,
  maxLines: DEFAULT_MAX_LINES,
};
```

Implement the sanitizer as a streaming state machine that retains one of `Text`, `Escape`, `Csi`, `Osc`, `OscEscape`, `ControlString`, or `ControlStringEscape` across `append` calls. Keep a `pendingCarriageReturn` flag in `Text`: CRLF becomes one LF, a standalone CR becomes one LF before the next ordinary character or at `finish()`, and raw CR is never retained.

- `ESC [` and C1 `CSI` enter `Csi` and discard through the final byte in `0x40..0x7e`.
- `ESC ]` and C1 `OSC` enter `Osc` and discard through BEL, C1 `ST`, or `ESC \`.
- `ESC P`, `ESC X`, `ESC ^`, `ESC _` and their C1 forms enter `ControlString` and discard through C1 `ST` or `ESC \`.
- Other two-byte ESC sequences are discarded.
- C0, DEL, and C1 controls are discarded except tab and LF; carriage returns follow the normalization rule above.
- `finish()` emits a pending normalized LF, discards any unterminated escape/control sequence, and is idempotent.

Use this streaming boundary so state is shared by head/tail retention instead of sanitizing chunks independently:

```ts
type SanitizerState =
  | "Text"
  | "Escape"
  | "Csi"
  | "Osc"
  | "OscEscape"
  | "ControlString"
  | "ControlStringEscape";

interface TerminalSanitizer {
  readonly append: (chunk: string, emit: (text: string) => void) => void;
  readonly finish: (emit: (text: string) => void) => void;
}

const makeTerminalSanitizer = (): TerminalSanitizer => {
  let state: SanitizerState = "Text";
  let pendingCarriageReturn = false;
  let finished = false;

  const append = (chunk: string, emit: (text: string) => void): void => {
    if (finished) return;
    for (const character of chunk) {
      const code = character.codePointAt(0) ?? 0;

      if (state === "Text" && pendingCarriageReturn) {
        pendingCarriageReturn = false;
        emit("\n");
        if (character === "\n") continue;
      }

      switch (state) {
        case "Text":
          if (character === "\r") pendingCarriageReturn = true;
          else if (character === "\u001b") state = "Escape";
          else if (code === 0x9b) state = "Csi";
          else if (code === 0x9d) state = "Osc";
          else if ([0x90, 0x98, 0x9e, 0x9f].includes(code))
            state = "ControlString";
          else if (
            character === "\t" ||
            character === "\n" ||
            (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))
          )
            emit(character);
          break;
        case "Escape":
          if (character === "[") state = "Csi";
          else if (character === "]") state = "Osc";
          else if (["P", "X", "^", "_"].includes(character))
            state = "ControlString";
          else if (code >= 0x20 && code <= 0x2f) state = "Escape";
          else state = character === "\u001b" ? "Escape" : "Text";
          break;
        case "Csi":
          if (code === 0x9c || (code >= 0x40 && code <= 0x7e)) state = "Text";
          else if (character === "\u001b") state = "Escape";
          break;
        case "Osc":
          if (character === "\u0007" || code === 0x9c) state = "Text";
          else if (character === "\u001b") state = "OscEscape";
          break;
        case "OscEscape":
          if (character === "\\") state = "Text";
          else state = character === "\u001b" ? "OscEscape" : "Osc";
          break;
        case "ControlString":
          if (code === 0x9c) state = "Text";
          else if (character === "\u001b") state = "ControlStringEscape";
          break;
        case "ControlStringEscape":
          if (character === "\\") state = "Text";
          else
            state =
              character === "\u001b" ? "ControlStringEscape" : "ControlString";
          break;
      }
    }
  };

  return {
    append,
    finish: (emit) => {
      if (finished) return;
      finished = true;
      if (state === "Text" && pendingCarriageReturn) emit("\n");
      state = "Text";
      pendingCarriageReturn = false;
    },
  };
};
```

Normalize injected limits to finite, floored, non-negative numbers. Feed sanitizer emissions directly into bounded retention, so no sanitized copy of an arbitrarily large child chunk is built. Store whole JavaScript code points in a deque with a compactable head index, track UTF-8 bytes plus LF count and the last retained code point incrementally, and use `text === "" ? 0 : lfCount + (text.endsWith("\n") ? 0 : 1)` for Pi-compatible logical-line accounting. Head mode stops retaining after either limit but continues advancing sanitizer state. Tail mode appends every safe code point and evicts from the front after every append once truncated.

Choose the first whole marker that fits one line and the byte limit from `"[... output omitted ...]"`, `"[omitted]"`, `"…"`, and `"."`; use no marker only when the limit is zero. Once truncated, reserve the chosen marker, one possible LF separator byte, and one marker line inside the same limits. Head snapshots put the marker after the retained prefix; tail snapshots put it before the retained suffix; avoid a duplicate LF when the retained side already supplies it. `snapshot()` joins only the bounded code-point deque and marker. No append, finish, or snapshot path may temporarily join an unbounded retained value, and evicted deque storage must be compacted once its unused prefix exceeds 4,096 entries and half the backing array.

Expose:

```ts
export const sanitizeTerminalText = (text: string): string;
export const makeHeadAccumulator = (
  limits?: OutputLimits,
): BoundedAccumulator;
export const makeTailAccumulator = (
  limits?: OutputLimits,
): BoundedAccumulator;
export const formatProgress = (completed: number, total: number): string =>
  "Subagents: " + String(completed) + "/" + String(total) + " completed";
```

- [ ] **Step 5: Implement deterministic fair aggregate formatting**

Use this display grammar:

```text
Subagent results:
1. completed — <single-line description>
2. failed — <single-line description> (exit 7)

[1] <single-line description>
cwd: <single-line absolute cwd>
stdout:
<bounded output or (no stdout)>

[2] <single-line description>
cwd: <single-line absolute cwd>
stdout:
<bounded output or (no stdout)>
stderr:
<bounded stderr>
```

Sanitize descriptions/cwds, replace tab/LF runs with one space, collapse repeated spaces, and trim display-only text without mutating details. Use `(unnamed task)` or `(unavailable cwd)` when sanitization empties a label. Cap each displayed description at 160 UTF-8 bytes and each displayed cwd at 240 UTF-8 bytes, ending clipped labels with one whole `…`. Build statuses first.

Use `(signal SIGTERM)` when a signal exists, otherwise `(exit N)` for a nonzero exit, otherwise `(execution failure)` for a failure without terminal data.

Precompute each full status line, full section, and minimum section skeleton (`[i] <description>\n[task output omitted by aggregate limit]`), plus suffix byte/line metrics for the skeletons. If the full status block and every minimum skeleton fit, reserve all later skeletons before rendering task `i`; divide only the discretionary bytes/lines by the remaining task count, render the current full section within that share, and carry unused capacity forward from actual metrics. A truncated section always keeps its label and ends with `[task output omitted by aggregate limit]`. Successful model-facing sections omit stderr; failed sections include it.

If the full statuses plus all minimum skeletons do not fit, render no task sections. Keep the largest ordered status prefix that fits together with `[N task statuses omitted]` when needed and `[N task output sections omitted by aggregate limit]` always. If an artificially tiny injected limit cannot fit the header and both notices, return a UTF-8-safe prefix of `[N task statuses and output sections omitted]`. Compute prefix/suffix metrics rather than repeatedly joining growing strings. Track aggregate bytes/lines as sections are appended and assert the final invariant with `Buffer.byteLength(text, "utf8") <= limits.maxBytes` plus the shared line counter. Do not apply a final head truncation: any defensive fallback must use the same reserved-space allocator so later labels cannot disappear after fairness has been established.

```ts
export const formatSubagentResults = (
  results: ReadonlyArray<SubagentTaskResult>,
  limits: OutputLimits = MODEL_OUTPUT_LIMITS,
): string;
```

- [ ] **Step 6: Run focused validation**

```bash
bun --bun vitest run src/subagents/output.test.ts --reporter verbose
bunx prettier --check src/subagents/output.ts src/subagents/output.test.ts
bun typecheck
git diff --check
```

Expected: sanitizer, UTF-8, head/tail, empty-output, mixed-result, status-omission, and fair-aggregate tests pass.

- [ ] **Step 7: Commit the output boundary**

```bash
git add src/subagents/output.ts src/subagents/output.test.ts
git commit -m "feat(subagents): bound and sanitize child output"
```

---

### Task 4: Execute ordered task batches through Process Service

**Files:**

- Create: `src/subagents/execution.ts`
- Test: `src/subagents/execution.test.ts`
- Create: `test/fixtures/subagent-child.ts`

**Interfaces:**

- Consumes: `ChildCommand`, `SubagentTask`, parent cwd, a shared `Effect.Semaphore`, and a settlement callback.
- Produces: `executeBatch(input): Effect<ReadonlyArray<SubagentTaskResult>, never, ProcessService>`; interruption stays in the Effect cause.

- [ ] **Step 1: Add a live fake child executable**

Create `test/fixtures/subagent-child.ts`. It must read all stdin with `Bun.stdin.text()`; parse `raw.trim()` as fixture control JSON, then write the original unmodified `raw` to `capturePath` before emitting output; maintain active/persistent-started markers; emit configured stdout/stderr/repeats; delay; and exit or self-signal.

```ts
import { once } from "node:events";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";

const FixtureControlSchema = Schema.Struct({
  taskId: Schema.optional(Schema.String),
  capturePath: Schema.optional(Schema.String),
  activeDirectory: Schema.optional(Schema.String),
  startedDirectory: Schema.optional(Schema.String),
  releaseDirectory: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.Array(Schema.String)),
  stderr: Schema.optional(Schema.Array(Schema.String)),
  stdoutRepeat: Schema.optional(Schema.Number),
  stderrRepeat: Schema.optional(Schema.Number),
  delayMs: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.Literal("SIGINT", "SIGTERM", "SIGKILL")),
});

const raw = await Bun.stdin.text();
const parsed: unknown = JSON.parse(raw.trim());
const control = Schema.decodeUnknownSync(FixtureControlSchema)(parsed);
const taskId = control.taskId ?? "task";

const markerPath = async (
  directory: string | undefined,
): Promise<string | undefined> => {
  if (directory === undefined) return undefined;
  await mkdir(directory, { recursive: true });
  const path = join(directory, taskId);
  await writeFile(path, "started\n", "utf8");
  return path;
};

const waitForRelease = async (): Promise<void> => {
  if (control.releaseDirectory === undefined) return;
  const path = join(control.releaseDirectory, taskId);
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      await delay(10);
    }
  }
};

const writeRepeated = async (
  stream: NodeJS.WriteStream,
  chunks: ReadonlyArray<string>,
  repeat: number,
): Promise<void> => {
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const chunk of chunks) {
      if (!stream.write(chunk)) await once(stream, "drain");
    }
  }
};

if (control.capturePath !== undefined) {
  await writeFile(control.capturePath, raw, "utf8");
}

const activePath = await markerPath(control.activeDirectory);
await markerPath(control.startedDirectory);

try {
  await waitForRelease();
  await Promise.all([
    writeRepeated(
      process.stdout,
      control.stdout ?? [],
      Math.max(0, Math.floor(control.stdoutRepeat ?? 1)),
    ),
    writeRepeated(
      process.stderr,
      control.stderr ?? [],
      Math.max(0, Math.floor(control.stderrRepeat ?? 1)),
    ),
  ]);
  await delay(Math.max(0, control.delayMs ?? 0));
  if (control.signal !== undefined) {
    process.kill(process.pid, control.signal);
    await new Promise<never>(() => undefined);
  }
  process.exitCode = Math.trunc(control.exitCode ?? 0);
} finally {
  if (activePath !== undefined) {
    await rm(activePath, { force: true });
  }
}
```

Signal tests must not request an active marker because self-signaling intentionally bypasses normal cleanup. The Effect Schema decode keeps the fixture free of unsafe assertions while still accepting the whitespace-padded JSON used by the byte-preservation test.

- [ ] **Step 2: Write failing live execution tests**

Create `src/subagents/execution.test.ts` with:

```ts
const fixtureCommand = (): ChildCommand => ({
  command: process.execPath,
  args: [
    fileURLToPath(
      new URL("../../test/fixtures/subagent-child.ts", import.meta.url),
    ),
  ],
});
```

Using one temporary directory per test, cover exact prompt bytes, default/relative cwd, successful empty output, out-of-order completion with request-order results, nonexistent cwd plus successful sibling, nonzero/signal plus successful siblings, output past both retention bounds, and two overlapping six-task calls sharing one semaphore. For the bound test, hold every child behind its per-task release file: wait until exactly three persistent-started markers exist, poll long enough to prove a fourth cannot start while those three remain live, release one task at a time, and assert each release admits at most one replacement. At the end, all twelve persistent markers must exist. This barrier makes a transient fourth child observable instead of relying on best-effort active-marker polling.

Use these named cases and exact outcomes; do not merge them into one opaque integration test:

| Test                                                  | Setup                                                                   | Required assertion                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `writes the prompt once without rewriting bytes`      | description `"not child input"`; whitespace-padded control prompt below | capture equals `prompt` and does not contain the description                                                 |
| `resolves default and relative cwd before scheduling` | omit cwd for one task; use `"nested"` for another                       | structured cwds equal `resolve(parentCwd)` and `resolve(parentCwd, "nested")`                                |
| `accepts clean empty stdout`                          | exit 0 with no stdout chunks                                            | `completed`, `output === ""`, code 0, null signal                                                            |
| `preserves request order`                             | delays 80/10/40 ms                                                      | descriptions remain first/second/third                                                                       |
| `isolates nonexistent cwd`                            | one missing directory beside one valid task                             | first is failed with spawn diagnostic; sibling completes                                                     |
| `isolates exit and signal failures`                   | exit 7, self-`SIGTERM`, and exit 0                                      | ordered failed/failed/completed with code/signal preserved                                                   |
| `drains beyond retention`                             | at least 2 MiB on each stream                                           | settles inside the test timeout; both snapshots satisfy both caps and carry omission markers                 |
| `enforces one global cap across calls`                | two six-task calls, one semaphore, release barriers                     | only three persistent starts before release; each release admits at most one; all twelve eventually complete |
| `publishes monotonic settlement counts`               | out-of-order batch with callback collector                              | callback values are exactly `[1, 2, 3]`                                                                      |

For the drain test, make the fixture write at least 2 MiB to each stream in chunks before exiting and set only the Vitest case timeout (10 seconds). Assert the task settles and both structured captures stay inside 50 KiB/2,000 lines; completion proves discarded bytes continued draining past normal pipe capacity without adding an extension timeout.

The stdin test must use:

```ts
const prompt =
  " \n" +
  JSON.stringify({
    taskId: "exact",
    capturePath,
    stdout: ["done"],
  }) +
  "\n ";
expect(await readFile(capturePath, "utf8")).toBe(prompt);
```

- [ ] **Step 3: Add scripted Process Service failure tests**

Inside the test file, define a local `Layer.succeed(ProcessService, scriptedService)` whose `spawnScoped` selects behavior by `options.cwd` and returns complete `ManagedProcess` objects. Provide:

- a stdout `Stream.fail(new ProcessError({ operation: "stream", message: "stdout broke" }))` with clean stderr/exit;
- a `writeStdin` failure with operation `stdin`;
- a `spawnScoped` failure with operation `spawn`;
- a successful child.

Run each failure beside a success and assert the sibling completes. Preserve known exit/signal values and bounded diagnostics. This explicitly proves spawn, stream, and stdin failures do not fail-fast/cancel siblings.

Name the cases `isolates a spawn failure`, `drains the sibling stream after a stdout failure`, and `shuts down while drains remain active after stdin failure`. In the stdin case, hold the fake shutdown until both drain observers record that they started, then complete its terminal deferred; assert shutdown occurred before either observer was interrupted. In all three cases assert the successful sibling is `completed` and the failed task's stderr contains the matching operation plus message.

Every successful scripted spawn must preserve the scoped service contract:

```ts
spawnScoped: (_command, _args, options) => {
  const child = childFor(options.cwd);
  return Effect.acquireRelease(
    Effect.succeed(child),
    (managed) => managed.shutdown.pipe(Effect.asVoid),
  );
},
```

Return `Effect.fail(new ProcessError({ operation: "spawn", message: "spawn broke" }))` for the spawn-failure cwd. Do not use a bare `Effect.succeed(child)`: cancellation tests depend on `shutdown` being installed as the scope finalizer.

- [ ] **Step 4: Add cancellation tests**

Add:

- a zero-permit semaphore test where abort rejects and `spawnScoped` is never called;
- a running never-exiting scripted child where abort triggers scoped `SIGTERM` cleanup and rejects rather than returning `failed`;
- a later call acquiring the permit, proving interruption leaked no capacity.

Run the effects through `makeEffectRunner` so each test supplies a real `AbortSignal`. For the queued case, abort after the invocation fiber starts and assert rejection plus zero spawn calls. For the running case, wait on a `spawned` deferred, abort, wait until `kill("SIGTERM")` is observed, resolve the replayable exit as `{ code: null, signal: "SIGTERM" }`, and assert the invocation rejects. Then run a one-task success with the same semaphore and assert it completes, which proves both the queue and running paths release permits.

- [ ] **Step 5: Run execution tests to verify RED**

```bash
bun --bun vitest run src/subagents/execution.test.ts --reporter verbose
```

Expected: FAIL because `./execution` and the fixture do not exist.

- [ ] **Step 6: Implement scoped single-task execution**

Create `src/subagents/execution.ts`:

```ts
import { resolve } from "node:path";
import { Duration, Effect, Fiber, Ref, Stream } from "effect";
import {
  type ProcessError,
  type ProcessExit,
  type ProcessShutdownPolicy,
  ProcessService,
} from "../services/process";
import type { ChildCommand } from "./child-command";
import {
  makeHeadAccumulator,
  makeTailAccumulator,
  type SubagentTaskResult,
} from "./output";

export interface SubagentTask {
  readonly description: string;
  readonly prompt: string;
  readonly cwd?: string;
}

interface ResolvedSubagentTask {
  readonly description: string;
  readonly prompt: string;
  readonly cwd: string;
}

export interface ExecuteBatchInput {
  readonly tasks: ReadonlyArray<SubagentTask>;
  readonly parentCwd: string;
  readonly command: ChildCommand;
  readonly semaphore: Effect.Semaphore;
  readonly onTaskSettled?: (completed: number) => void;
}

export const SUBAGENT_SHUTDOWN_POLICY = {
  stdinCloseTimeout: Duration.millis(100),
  gracefulTimeout: Duration.seconds(1),
  forcedTimeout: Duration.seconds(1),
  totalTimeout: Duration.millis(2_100),
} satisfies ProcessShutdownPolicy;

type ProcessObservation<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: ProcessError };

interface TaskObservation {
  readonly terminal: ProcessExit | null;
  readonly errors: ReadonlyArray<ProcessError>;
}

const observeProcess = <A, R>(
  effect: Effect.Effect<A, ProcessError, R>,
): Effect.Effect<ProcessObservation<A>, never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error): ProcessObservation<A> => ({
        _tag: "Failure",
        error,
      }),
      onSuccess: (value): ProcessObservation<A> => ({
        _tag: "Success",
        value,
      }),
    }),
  );

const executeTask = (
  task: ResolvedSubagentTask,
  input: ExecuteBatchInput,
): Effect.Effect<SubagentTaskResult, never, ProcessService>;
```

Before starting task effects, map every request to an internal `ResolvedSubagentTask` with `cwd: resolve(input.parentCwd, task.cwd ?? ".")`. This is pure path resolution for the full batch; nonexistent or non-directory paths remain task-level `spawnScoped` failures because Process Service owns process acquisition.

For each resolved task:

1. create head/tail accumulators outside the child scope;
2. wrap `Effect.scoped(runChild)` in `semaphore.withPermits(1)` so the permit covers spawn through cleanup;
3. call `spawnScoped(command.command, command.args, { cwd: task.cwd, stdio: "pipe" }, SUBAGENT_SHUTDOWN_POLICY)`;
4. fork stdout, stderr, and replayable `waitForExit` observers before stdin delivery;
5. call `writeStdin(task.prompt)` once, then await `endStdin`;
6. await `waitForExit` and both drains;
7. append typed diagnostics, then call `finish()` before taking snapshots.

Use independent `ProcessObservation` values through `observeProcess` rather than `Effect.exit`, so typed process failures become task data but interruption/defects still propagate:

```ts
const drainStdout = Stream.runForEach(child.stdoutLines, (line) =>
  Effect.sync(() => stdout.append(line + "\n")),
).pipe(observeProcess);

const drainStderr = Stream.runForEach(child.stderrChunks, (chunk) =>
  Effect.sync(() => stderr.append(chunk)),
).pipe(observeProcess);
```

Start all three observers with `Effect.forkScoped`; the wait observer is `observeProcess(child.waitForExit)`. Observe `child.writeStdin(task.prompt).pipe(Effect.zipRight(child.endStdin), observeProcess)` in the task fiber. On stdin failure, invoke the idempotent `child.shutdown` while both stream observers are still draining. On wait failure, do the same. If shutdown reports a confirmed terminal result, join both drains; if it reports `terminalUnconfirmed`, interrupt the observer fibers before leaving the scope. On the normal path, join the successful terminal wait and both independent drains. This avoids a pipe deadlock during bounded shutdown while still letting caller interruption escape the task.

Collect typed failures into an array of `"[operation] message"` diagnostics. When explicit shutdown was needed, also include its `stdin` failure, `signalErrors`, `processErrors`, terminal failure, deadline/terminal-unconfirmed flags, and `internalFailure`; use its `Exited` terminal value when the wait observer did not supply one. Append those diagnostics to the still-open tail accumulator, then finish both accumulators and take snapshots. An outer interruption-only ensuring action may call the idempotent `finish()` methods for cleanup, but normal classification must happen before they are finished. Preserve a known terminal exit even if either stream failed.

Classify completion with the explicit non-null guard (do not rely on optional-chain narrowing):

```ts
const completed =
  observation.terminal !== null &&
  observation.errors.length === 0 &&
  observation.terminal.code === 0 &&
  observation.terminal.signal === null;
```

The error list includes stdin EOF and both drain observations, so this predicate requires confirmed EOF and successful drains. Every other settled outcome returns `failed` with captured stdout, captured/diagnostic stderr, and known exit fields or null. Catch typed task failures only; do not catch interruption causes.

Attach non-empty bounded stderr to structured details for both statuses. The final formatter hides it for successful tasks and shows it for failures. Even an all-failed batch is an ordinary completed tool result with ordered failed details; do not mark the whole batch as a tool-level error.

- [ ] **Step 7: Implement ordered batch concurrency and progress counting**

```ts
export const executeBatch = (
  input: ExecuteBatchInput,
): Effect.Effect<ReadonlyArray<SubagentTaskResult>, never, ProcessService> =>
  Effect.gen(function* () {
    const completed = yield* Ref.make(0);
    const progressMutex = yield* Effect.makeSemaphore(1);
    const tasks: ReadonlyArray<ResolvedSubagentTask> = input.tasks.map(
      (task) => ({
        ...task,
        cwd: resolve(input.parentCwd, task.cwd ?? "."),
      }),
    );
    return yield* Effect.forEach(
      tasks,
      (task) =>
        executeTask(task, input).pipe(
          Effect.tap(() =>
            progressMutex.withPermits(1)(
              Ref.updateAndGet(completed, (count) => count + 1).pipe(
                Effect.tap((count) =>
                  Effect.sync(() => {
                    try {
                      input.onTaskSettled?.(count);
                    } catch {
                      // Progress reporting cannot affect execution.
                    }
                  }),
                ),
              ),
            ),
          ),
        ),
      { concurrency: 3 },
    );
  });
```

`Effect.forEach` preserves request order. Per-call concurrency limits started effects; `input.semaphore` supplies the cross-call live-process cap.

- [ ] **Step 8: Run focused validation**

```bash
bun --bun vitest run src/subagents/execution.test.ts --reporter verbose
bunx prettier --check src/subagents/execution.ts src/subagents/execution.test.ts test/fixtures/subagent-child.ts
bun typecheck
git diff --check
```

Expected: stdin/cwd/order/exit/signal/drain/global-cap tests and scripted I/O/cancellation tests pass without credentials.

- [ ] **Step 9: Commit the execution primitive**

```bash
git add src/subagents/execution.ts src/subagents/execution.test.ts test/fixtures/subagent-child.ts
git commit -m "feat(subagents): execute bounded child batches"
```

---

### Task 5: Register the strict tool and own runtime shutdown

**Files:**

- Create: `src/subagents/index.ts`
- Test: `src/subagents/index.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: Pi `ExtensionAPI`/`ExtensionContext`, `buildChildCommand`, `executeBatch`, and `makeEffectRunner`.
- Produces strict `SubagentRequest`, progress/final `SubagentToolDetails`, shared runtime semaphore/work scope, and idempotent shutdown.

- [ ] **Step 1: Declare the direct Pi AI dependency with Bun**

Add `@earendil-works/pi-ai` while keeping every existing entry. The affected blocks become:

```json
"peerDependencies": {
  "@earendil-works/pi-ai": "*",
  "@earendil-works/pi-coding-agent": "*",
  "@earendil-works/pi-tui": "*"
},
"devDependencies": {
  "@earendil-works/pi-ai": "^0.80.7",
  "@earendil-works/pi-coding-agent": "^0.80.7",
  "@earendil-works/pi-tui": "^0.80.7",
  "@effect/cli": "^0.76.0",
  "@effect/language-service": "^0.87.0",
  "@effect/platform": "^0.97.0",
  "@effect/platform-bun": "^0.91.0",
  "@effect/vitest": "^0.30.0",
  "@eslint/js": "^10.0.1",
  "@trivago/prettier-plugin-sort-imports": "^6.0.2",
  "@types/bun": "^1.3.14",
  "@types/node": "^26.1.1",
  "eslint": "^10.7.0",
  "prettier": "^3.9.5",
  "typescript": "^6.0.3",
  "typescript-eslint": "^8.64.0",
  "vitest": "^3.2.7"
}
```

Then run:

```bash
bun install
```

Expected: `package.json` and `bun.lock` record the direct Pi AI import without unrelated upgrades.

- [ ] **Step 2: Write failing strict-schema and registration tests**

Create a harness in `src/subagents/index.test.ts` that captures the concrete tool and shutdown handler. Use `validateToolArguments` from `@earendil-works/pi-ai`. Cover:

- exactly one `subagent` tool with `executionMode: "parallel"`;
- empty tasks and whitespace-only description/prompt rejected;
- root/task unknown properties rejected;
- `agent`, `model`, `thinking`, `tools`, `concurrency`, `output`, `timeout`, and retry knobs rejected;
- a large non-empty task array accepted;
- accepted prompt edges preserved.

Define the validation helper without assertions:

```ts
import type { ToolCall } from "@earendil-works/pi-ai";

const toolCall = (arguments_: Record<string, unknown>): ToolCall => ({
  type: "toolCall",
  id: "test-call",
  name: "subagent",
  arguments: arguments_,
});
```

Build the registration harness around these exact retrieval rules so tests never use non-null assertions:

```ts
const tools: RegisteredSubagentTool[] = [];
let shutdown: (() => Promise<void>) | undefined;
let thinkingReads = 0;
let thinkingLevel = "high";

const port: SubagentRegistrationPort = {
  registerTool: (tool) => tools.push(tool),
  onSessionShutdown: (handler) => {
    shutdown = handler;
  },
  getThinkingLevel: () => {
    thinkingReads += 1;
    return thinkingLevel;
  },
};

const onlyTool = (): RegisteredSubagentTool => {
  const tool = tools[0];
  if (tool === undefined || tools.length !== 1) {
    throw new Error("expected exactly one registered subagent tool");
  }
  return tool;
};

const shutdownHandler = (): (() => Promise<void>) => {
  if (shutdown === undefined) throw new Error("shutdown was not registered");
  return shutdown;
};
```

For forbidden fields, iterate exactly `agent`, `model`, `thinking`, `tools`, `concurrency`, `output`, `timeout`, `retry`, `retries`, and `maxRetries` at the request root and assert every validation throws. Separately place `unknown: true` inside a task. Build the no-maximum case with 1,000 valid tasks and assert validation succeeds without truncating the array.

```ts
const accepted = validateToolArguments(
  tool,
  toolCall({
    tasks: [
      {
        description: " inspect ",
        prompt: " \nkeep these edges\n ",
      },
    ],
  }),
);
expect(accepted.tasks[0].prompt).toBe(" \nkeep these edges\n ");
```

- [ ] **Step 3: Write failing snapshot, progress, and lifecycle tests**

Inject a runtime facade that records calls and returns ordered results. Assert missing model starts no runtime; a rejected runtime initialization remains a tool-level rejection with no synthesized task result; provider/id/thinking are read once before execution; later parent mutations do not affect the command; progress is `0/N` then synchronized completion counts; a throwing update callback cannot reject execution; progress contains no prompt/child output; final details retain all results; and repeated shutdown uses one disposal promise.

Use these separate named cases and outcomes:

| Test                                                               | Required assertion                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rejects before runtime when the parent model is missing`          | execute rejects with the active-model message; runtime calls and thinking reads stay zero                                                                                      |
| `does not translate runtime initialization failure into task data` | injected `run` rejects with `runtime failed`; the same rejection escapes and no complete details exist                                                                         |
| `snapshots model and thinking once per invocation`                 | command builder records the original provider/id/level; mutate context and `thinkingLevel` after `run` starts; recorded command/input stay unchanged and `thinkingReads === 1` |
| `publishes only synchronized coarse progress`                      | injected runtime calls settlement callback in order 1/2; update texts are exactly `0/2`, `1/2`, `2/2`; serialized details contain counts but neither prompt nor child output   |
| `ignores a throwing progress callback`                             | update throws on every call; execute still returns the injected ordered results                                                                                                |
| `returns bounded text plus every structured result`                | content is one text item equal to `formatSubagentResults(results)` and complete details reference all ordered results                                                          |
| `memoizes shutdown disposal`                                       | call the captured handler twice before resolving dispose; promises are identical and dispose is called once                                                                    |

Add one real scoped-runtime case by creating `makeEffectRunner(Layer.merge(scriptedProcessLayer, SubagentRuntimeStateLive))` and wrapping it with `makeSubagentRuntime`. Start a scripted child whose replayable exit is pending, call the captured shutdown handler, observe `SIGTERM`, then resolve exit as `{ code: null, signal: "SIGTERM" }`. Assert shutdown resolves, invocation rejects as interrupted rather than returning task details, and a second shutdown returns the same promise without a second runtime disposal. This test must use `Effect.acquireRelease(..., managed.shutdown)` in the scripted `spawnScoped`, just like Task 4.

- [ ] **Step 4: Run index tests to verify RED**

```bash
bun --bun vitest run src/subagents/index.test.ts --reporter verbose
```

Expected: FAIL because `src/subagents/index.ts` does not exist.

- [ ] **Step 5: Add strict schemas and detail types**

```ts
import { Type, type Static } from "@earendil-works/pi-ai";

const NonBlankString = Type.String({ pattern: "\\S" });

export const SubagentTaskSchema = Type.Object(
  {
    description: NonBlankString,
    prompt: NonBlankString,
    cwd: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SubagentRequestSchema = Type.Object(
  {
    tasks: Type.Array(SubagentTaskSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type SubagentRequest = Static<typeof SubagentRequestSchema>;

export type SubagentToolDetails =
  | {
      readonly _tag: "Progress";
      readonly completed: number;
      readonly total: number;
    }
  | {
      readonly _tag: "Complete";
      readonly results: ReadonlyArray<SubagentTaskResult>;
    };
```

Do not define `prepareArguments`; Pi validates the original strict object.

- [ ] **Step 6: Add scoped runtime state and caller-local interruption**

```ts
interface SubagentRuntimeState {
  readonly semaphore: Effect.Semaphore;
  readonly workScope: Scope.CloseableScope;
}

const SubagentRuntimeState = Context.GenericTag<SubagentRuntimeState>(
  "pi-extensions/SubagentRuntimeState",
);

export const SubagentRuntimeStateLive = Layer.scoped(
  SubagentRuntimeState,
  Effect.gen(function* () {
    const semaphore = yield* Effect.makeSemaphore(3);
    const workScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(workScope, exit));
    return { semaphore, workScope };
  }),
);

export const SubagentLiveLayer = Layer.merge(
  ProcessService.Live,
  SubagentRuntimeStateLive,
);
```

Run every batch fiber in `workScope` but acquire it in a caller-local scope:

```ts
const runInvocation = (
  input: Omit<ExecuteBatchInput, "semaphore">,
): Effect.Effect<
  ReadonlyArray<SubagentTaskResult>,
  never,
  ProcessService | SubagentRuntimeState
> =>
  Effect.gen(function* () {
    const state = yield* SubagentRuntimeState;
    const fiber = yield* Effect.acquireRelease(
      Effect.forkIn(
        executeBatch({ ...input, semaphore: state.semaphore }),
        state.workScope,
      ),
      (active) => Fiber.interrupt(active).pipe(Effect.asVoid),
    );
    return yield* Fiber.join(fiber);
  }).pipe(Effect.scoped);
```

Tool-signal interruption closes the local scope and interrupts its batch. ManagedRuntime disposal closes the layer work scope and waits for all batch/process finalizers.

- [ ] **Step 7: Register one tool and bridge Pi context**

Define the runner-backed facade that the registration tests inject:

```ts
type SubagentDependencies = ProcessService | SubagentRuntimeState;

export interface SubagentEffectRunner {
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, SubagentDependencies>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<A>;
  readonly dispose: () => Promise<void>;
}

export interface SubagentRuntime {
  readonly run: (
    input: Omit<ExecuteBatchInput, "semaphore">,
    signal: AbortSignal | undefined,
  ) => Promise<ReadonlyArray<SubagentTaskResult>>;
  readonly dispose: () => Promise<void>;
}

export const makeSubagentRuntime = (
  runner: SubagentEffectRunner,
): SubagentRuntime => ({
  run: (input, signal) =>
    runner.runPromise(
      runInvocation(input),
      signal === undefined ? undefined : { signal },
    ),
  dispose: runner.dispose,
});
```

Follow the repository registration-port pattern with these exact boundary types:

```ts
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type SubagentToolResult = AgentToolResult<SubagentToolDetails>;
type SubagentUpdate = (result: SubagentToolResult) => void;

export interface SubagentParentContext {
  readonly cwd: string;
  readonly model?: {
    readonly provider: string;
    readonly id: string;
  };
}

export interface RegisteredSubagentTool {
  readonly name: "subagent";
  readonly label: string;
  readonly description: string;
  readonly parameters: typeof SubagentRequestSchema;
  readonly executionMode: "parallel";
  readonly execute: (
    params: SubagentRequest,
    signal: AbortSignal | undefined,
    onUpdate: SubagentUpdate | undefined,
    context: SubagentParentContext,
  ) => Promise<SubagentToolResult>;
}

export interface SubagentRegistrationPort {
  readonly registerTool: (tool: RegisteredSubagentTool) => void;
  readonly onSessionShutdown: (handler: () => Promise<void>) => void;
  readonly getThinkingLevel: () => string;
}

export const registerSubagent = (
  port: SubagentRegistrationPort,
  runtime: SubagentRuntime,
  commandBuilder: (snapshot: ParentSnapshot) => ChildCommand =
    buildChildCommand,
): void;
```

Register:

```ts
{
  name: "subagent",
  label: "Subagents",
  description:
    "Run one or more isolated Pi coding tasks and return ordered bounded results.",
  parameters: SubagentRequestSchema,
  executionMode: "parallel",
}
```

Implement the boundary without catching runtime/tool-level failures:

```ts
const publishProgress = (
  update: SubagentUpdate | undefined,
  completed: number,
  total: number,
): void => {
  try {
    update?.({
      content: [{ type: "text", text: formatProgress(completed, total) }],
      details: { _tag: "Progress", completed, total },
    });
  } catch {
    // Pi progress callbacks are advisory and cannot change task execution.
  }
};

export const registerSubagent = (
  port: SubagentRegistrationPort,
  runtime: SubagentRuntime,
  commandBuilder: (
    snapshot: ParentSnapshot,
  ) => ChildCommand = buildChildCommand,
): void => {
  port.registerTool({
    name: "subagent",
    label: "Subagents",
    description:
      "Run one or more isolated Pi coding tasks and return ordered bounded results.",
    parameters: SubagentRequestSchema,
    executionMode: "parallel",
    execute: async (params, signal, onUpdate, context) => {
      const model = context.model;
      if (model === undefined) {
        throw new Error("subagent requires an active parent model");
      }

      const snapshot: ParentSnapshot = {
        provider: model.provider,
        modelId: model.id,
        thinkingLevel: port.getThinkingLevel(),
      };
      const command = commandBuilder(snapshot);
      const total = params.tasks.length;
      publishProgress(onUpdate, 0, total);

      const results = await runtime.run(
        {
          tasks: params.tasks,
          parentCwd: context.cwd,
          command,
          onTaskSettled: (completed) =>
            publishProgress(onUpdate, completed, total),
        },
        signal,
      );

      return {
        content: [{ type: "text", text: formatSubagentResults(results) }],
        details: { _tag: "Complete", results },
      };
    },
  });

  let shutdownPromise: Promise<void> | undefined;
  port.onSessionShutdown(() => {
    shutdownPromise ??= runtime.dispose();
    return shutdownPromise;
  });
};
```

This snapshots provider/id/thinking once, builds one command per invocation, publishes synchronized counts, and returns one formatted text item plus `{ _tag: "Complete", results }` details. Each update is exactly:

```ts
{
  content: [{ type: "text", text: formatProgress(completed, total) }],
  details: { _tag: "Progress", completed, total },
}
```

Register `session_shutdown` with one memoized `runtime.dispose()` promise. Do not register `session_start` or start a process in the factory. Export `SubagentRuntimeStateLive` so the scoped-runtime test can merge it with a scripted Process Service layer.

The default export creates `makeEffectRunner(SubagentLiveLayer)`, wraps it with `makeSubagentRuntime`, and adapts real Pi tool/update/context types to the testable port. Its Pi `ToolDefinition.execute` adapter ignores only `toolCallId` and maps `ExtensionContext` to `SubagentParentContext` without assertions:

```ts
const toParentContext = (context: ExtensionContext): SubagentParentContext => {
  const model = context.model;
  return {
    cwd: context.cwd,
    ...(model === undefined
      ? {}
      : { model: { provider: model.provider, id: model.id } }),
  };
};

export default function subagentExtension(pi: ExtensionAPI): void {
  const runtime = makeSubagentRuntime(makeEffectRunner(SubagentLiveLayer));

  registerSubagent(
    {
      registerTool: (tool) => {
        const nativeTool: ToolDefinition<
          typeof SubagentRequestSchema,
          SubagentToolDetails
        > = {
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: tool.parameters,
          executionMode: tool.executionMode,
          execute: (_toolCallId, params, signal, onUpdate, context) =>
            tool.execute(params, signal, onUpdate, toParentContext(context)),
        };
        pi.registerTool(nativeTool);
      },
      onSessionShutdown: (handler) =>
        pi.on("session_shutdown", () => handler()),
      getThinkingLevel: () => pi.getThinkingLevel(),
    },
    runtime,
  );
}
```

- [ ] **Step 8: Run focused validation**

```bash
bun --bun vitest run src/subagents/index.test.ts src/lib/effect-runtime.test.ts --reporter verbose
bunx prettier --check src/subagents/index.ts src/subagents/index.test.ts package.json
bun typecheck
git diff --check
```

Expected: schema, snapshot, progress, runtime interruption, and idempotent shutdown tests pass.

- [ ] **Step 9: Commit the registered but unpublished extension**

```bash
git add src/subagents/index.ts src/subagents/index.test.ts package.json bun.lock
git commit -m "feat(subagents): register basic tool lifecycle"
```

The manifest entrypoint remains unchanged until the living-contract publication task.

---

### Task 6: Publish the extension and living specifications

**Files:**

- Modify: `package.json`
- Test: `test/package-manifest.test.ts`
- Create: `docs/specs/subagents.md`
- Modify: `docs/specs/index.md`
- Modify: `docs/specs/extensions.md`

**Interfaces:**

- Consumes: tested `src/subagents/index.ts`.
- Produces: Pi manifest discovery and the living user-visible/architectural contract.

- [ ] **Step 1: Update the manifest test first**

Change the exact array:

```ts
expect(packageJson.pi.extensions).toEqual([
  "./src/attention-hooks/index.ts",
  "./src/custom-footer/index.ts",
  "./src/history-picker/index.ts",
  "./src/subagents/index.ts",
]);
```

Replace the dependency test body with:

```ts
it("declares directly imported Pi-hosted APIs", () => {
  expect(packageJson.peerDependencies).toMatchObject({
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  });
  expect(packageJson.devDependencies).toMatchObject({
    "@earendil-works/pi-ai": "^0.80.7",
    "@earendil-works/pi-coding-agent": "^0.80.7",
    "@earendil-works/pi-tui": "^0.80.7",
  });
});
```

- [ ] **Step 2: Run the package test to verify RED**

```bash
bun --bun vitest run test/package-manifest.test.ts --reporter verbose
```

Expected: FAIL because `package.json#pi.extensions` does not yet list `./src/subagents/index.ts`.

- [ ] **Step 3: Add only the new entrypoint**

Use this exact discovery block; do not list helper modules:

```json
"pi": {
  "extensions": [
    "./src/attention-hooks/index.ts",
    "./src/custom-footer/index.ts",
    "./src/history-picker/index.ts",
    "./src/subagents/index.ts"
  ]
}
```

- [ ] **Step 4: Add the owning living specification**

Create `docs/specs/subagents.md` with this contract-level content (well under 300 lines):

```markdown
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
```

- [ ] **Step 5: Register the living spec and extension**

Add to `docs/specs/index.md`:

```markdown
- [Subagents](./subagents.md) — isolated Pi child execution, concurrency, progress, bounded results, and cancellation.
```

In `docs/specs/extensions.md` add Subagents to **Current Extensions** and the validation cross-reference. Keep the generic dependency policy. Do not edit `process-service.md`, `architecture.md`, or `test-services.md`.

```diff
@@ Current Extensions
 - [History picker](./history-picker.md) provides interactive search across current and saved user messages.
+- [Subagents](./subagents.md) provides isolated, bounded Pi child execution for delegated coding tasks.

@@ Validation
-Extension changes pass `bun run check`, including the [attention-hooks](./attention-hooks.md), [custom-footer](./custom-footer.md), and [history-picker](./history-picker.md) feature contracts.
+Extension changes pass `bun run check`, including the [attention-hooks](./attention-hooks.md), [custom-footer](./custom-footer.md), [history-picker](./history-picker.md), and [subagents](./subagents.md) feature contracts.
```

- [ ] **Step 6: Run publication validation**

```bash
bun --bun vitest run test/package-manifest.test.ts src/subagents/index.test.ts --reporter verbose
bunx prettier --check package.json test/package-manifest.test.ts docs/specs/subagents.md docs/specs/index.md docs/specs/extensions.md
bun typecheck
git diff --check
```

Expected: manifest/registration tests pass, changed documents are formatted, and whitespace checks succeed.

- [ ] **Step 7: Review and commit the publication gate**

```bash
git diff -- package.json test/package-manifest.test.ts docs/specs/subagents.md docs/specs/index.md docs/specs/extensions.md
git status --short
git add package.json test/package-manifest.test.ts docs/specs/subagents.md docs/specs/index.md docs/specs/extensions.md
git commit -m "feat(subagents): publish basic extension"
```

Expected: the commit contains only the entrypoint/test and owning living specifications.

---

## Final Controller Verification

After all six task review gates pass:

1. Format-check every changed source, test, fixture, manifest, and specification:

   ```bash
   bunx prettier --check src/lib/effect-runtime.ts src/lib/effect-runtime.test.ts src/subagents test/fixtures/subagent-child.ts package.json test/package-manifest.test.ts docs/specs/subagents.md docs/specs/index.md docs/specs/extensions.md
   ```

2. Run complete validation:

   ```bash
   bun run check
   ```

   Expected: source/test/kit typechecks, ESLint, and all Vitest suites exit zero.

3. Validate isolated global linking and credential-free extension loading:

   ```bash
   SUBAGENT_AGENT_DIR=$(mktemp -d)
   PI_CODING_AGENT_DIR="$SUBAGENT_AGENT_DIR" bun run pi:link-global
   test "$(readlink "$SUBAGENT_AGENT_DIR/extensions/pi-extensions")" = "$(pwd -P)"
   PI_CODING_AGENT_DIR="$SUBAGENT_AGENT_DIR" node_modules/.bin/pi --help >/dev/null
   PI_CODING_AGENT_DIR="$SUBAGENT_AGENT_DIR" bun run pi:unlink-global
   rmdir "$SUBAGENT_AGENT_DIR/extensions"
   rmdir "$SUBAGENT_AGENT_DIR"
   ```

   Expected: the link targets the implementation worktree, Pi loads configured entrypoints before help, unlink succeeds, and the temporary directory is removable.

4. Review the branch against the approved base:

   ```bash
   git diff --check
   git diff --stat main...HEAD
   git diff main...HEAD
   git status --short --branch
   ```

5. Map the final diff to living specs:

   - `src/subagents/**` and the manifest are owned by `docs/specs/subagents.md` and `docs/specs/extensions.md`.
   - `src/lib/effect-runtime.ts` is internal cancellation plumbing described by the subagent lifecycle; it does not change Process Service.
   - Tests/fixtures need no separate specification.
   - Confirm `.context` and `docs/specs/process-service.md` are unchanged.

6. Dispatch a final whole-branch code review. Fix any defect or contract gap in a focused commit, then repeat Steps 1–5 before declaring completion.
