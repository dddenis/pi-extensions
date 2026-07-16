# Retry-Aware Subagent Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat a Pi-confirmed successful automatic provider retry as recovered diagnostic history so a later valid settled `complete_subagent` result can durably finish with its semantic status.

**Architecture:** Extend the strict Pi JSONL accumulator with an explicit retry protocol state machine around `agent_end`, `auto_retry_start`, and `auto_retry_end`. Keep the latest provider stop terminal until the matching retry attempt succeeds, retain that recovered stop as a bounded sanitized diagnostic, and let `RunExecutor` merge the accumulator's recovered diagnostics into every terminal candidate before the existing atomic status commit. Exercise the behavior first at the accumulator boundary, then at executor durability, and finally through the real fake-Pi process and rendering path.

**Tech Stack:** Bun 1.3, TypeScript 6, Effect 3.22, Effect Schema, Pi 0.80.7 JSON event mode, Vitest 3.2, `@effect/vitest`.

## Global Constraints

- The approved source is `docs/superpowers/specs/2026-07-16-retry-aware-subagent-finalization-design.md`; preserve its goals, failure precedence, acceptance sequence, implementation boundaries, and non-goals.
- Strictly decode Pi 0.80.7 `agent_end { messages, willRetry }`, `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage }`, and `auto_retry_end { success, attempt, finalError? }` events.
- Unknown future event types remain ignored; missing, malformed, contradictory, mismatched, repeated, or invalidly ordered recognized retry evidence permanently fails the event stream.
- Recovery requires a matching `auto_retry_end { success: true }`; later assistant work, a valid completion call, settlement, or exit code zero must never heuristically clear a provider failure.
- Unretried errors, retry exhaustion, retry cancellation, unresolved aborts, failed process/stream/report evidence, invalid completion, missing settlement, and status-store failures retain the existing terminal behavior and precedence.
- A recovered failure becomes a bounded, terminal-safe, single-line diagnostic and cannot change semantic status, summary, report path, concise model-facing text, or collapsed rendering.
- Raw `events.jsonl` remains byte-for-byte transport evidence; only the derived diagnostic is sanitized and bounded.
- Preserve exact completion correlation, usage aggregation at assistant `message_end`, process output draining, atomic terminal commitment, fallback durability, cancellation, ordered results, private modes, and existing progress/rendering policies.
- Use Bun commands and Effect patterns; do not add dependencies, edit `.context/`, use unsafe assertions/non-null assertions, add redispatch behavior, or broaden milestone-one APIs.
- Update only the owning living contract `docs/specs/subagents.md`; existing schema, run-store, batch, and renderer contracts already carry and hide diagnostics correctly.

---

## File and Responsibility Map

### Retry interpretation

- Modify `src/subagents/pi-events.ts` — own strict retry schemas, sequence validation, unresolved/recovered provider state, diagnostic derivation, and retry-aware finalization.
- Modify `src/subagents/pi-events.test.ts` — prove valid single/multiple retry recovery, unresolved terminal outcomes, diagnostic safety, and fail-closed malformed ordering.

### Durable terminal propagation

- Modify `src/subagents/run-executor.ts` — merge recovered accumulator diagnostics into every executor terminal candidate immediately before the existing commit path.
- Modify `src/subagents/run-executor.test.ts` — prove returned and persisted semantic results retain the recovered diagnostic without changing completion data.

### Real-process acceptance

- Modify `test/fixtures/fake-pi.ts` — add one retry-success JSONL mode and a real report file while preserving every existing mode's transcript.
- Modify `src/subagents/subagents.integration.test.ts` — verify exact event ordering, raw evidence, process exit/drain, durable status, report path, and collapsed/expanded/model rendering.

### Living documentation

- Modify `docs/specs/subagents.md` — distinguish unrecovered/final provider stops from Pi-confirmed recovered retry history.

No change is required in `src/subagents/schemas.ts`, `src/subagents/run-store.ts`, `src/subagents/render.ts`, `src/subagents/batch.ts`, package metadata, dependencies, or `.context/`.

## Frozen Interfaces Between Tasks

Use these names and shapes consistently so later tasks consume earlier work without reinterpretation:

```ts
// src/subagents/pi-events.ts
interface ProviderFailure {
  readonly stopReason: "error" | "aborted";
  readonly message?: string;
}

interface MutableProviderFailure extends ProviderFailure {
  readonly observedAtLine: number;
  retryAnnounced: boolean;
}

interface ActiveRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly sourceFailureLine: number;
  failed: boolean;
}

export interface PiEventAccumulatorSnapshot {
  readonly sessionId?: string;
  readonly usage: RunUsage;
  readonly settled: boolean;
  readonly completion?: CompletionResult;
  readonly completionInvalidated: boolean;
  readonly providerFailure?: ProviderFailure;
  readonly recoveredDiagnostics: ReadonlyArray<string>;
}
```

The existing `PiEventFinalization` union remains unchanged. `RunExecutor` reads `snapshot.recoveredDiagnostics` at its single terminal commit gate so diagnostics survive semantic completion and later process/stream failures without duplicating fields in durable schemas.

Retry-chain invariants:

1. Attempts start at `1` and increase by exactly one while the same chain remains unresolved.
2. `maxAttempts` remains constant within one chain and every `attempt` is less than or equal to it.
3. `auto_retry_start.errorMessage` must match the unresolved provider message when that message exists; otherwise it becomes the provider diagnostic message.
4. A new provider stop while an attempt is active marks that attempt failed; Pi may announce the next attempt without an intermediate `auto_retry_end`.
5. A successful `auto_retry_end` is valid only for the matching active attempt before another provider stop; `finalError` on success is contradictory.
6. A failed `auto_retry_end` preserves the unresolved stop, preferring its `finalError` when present.
7. Completing a retry chain resets attempt sequencing so a later independent chain may begin again at attempt `1`.
8. `agent_settled` is invalid while a retry is announced or active.

---

### Task 1: Implement Strict Retry-Aware Event Accumulation

**Files:**

- Modify: `src/subagents/pi-events.test.ts:6-111,883-936`
- Modify: `src/subagents/pi-events.ts:186-254,297-370,405-535,538-626`

**Interfaces:**

- Consumes: current strict JSON/event decoding, structured-completion correlation, usage aggregation, settlement, and process-exit precedence.
- Produces: the frozen `ProviderFailure`, `ActiveRetry`, and `PiEventAccumulatorSnapshot.recoveredDiagnostics` contracts plus a fail-closed retry state machine.
- Task boundary: schemas, transitions, finalization behavior, and their unit tests change together so no commit temporarily trusts retry events without validating them.

- [ ] **Step 1: Add reusable retry fixtures to the accumulator tests**

In `src/subagents/pi-events.test.ts`, replace the current `validCompletion` helper with these explicit completion/retry helpers:

```ts
const completionEvidence = (id = "completion-1") => ({
  assistant: assistantEnd({
    calls: [{ id, name: "complete_subagent" }],
  }),
  start: {
    type: "tool_execution_start",
    toolCallId: id,
    toolName: "complete_subagent",
    args: { status: "DONE" },
  },
  end: completionEnd(id),
});

const validCompletion = (id = "completion-1") => {
  const completion = completionEvidence(id);
  return [
    completion.assistant,
    completion.start,
    completion.end,
    { type: "agent_settled" },
  ];
};

const agentEnd = (
  willRetry: boolean,
  messages: ReadonlyArray<unknown> = [],
) => ({
  type: "agent_end",
  messages,
  willRetry,
});

const autoRetryStart = (
  attempt: number,
  options: {
    readonly maxAttempts?: number;
    readonly delayMs?: number;
    readonly errorMessage?: string;
  } = {},
) => ({
  type: "auto_retry_start",
  attempt,
  maxAttempts: options.maxAttempts ?? 3,
  delayMs: options.delayMs ?? 10,
  errorMessage: options.errorMessage ?? "WebSocket error",
});

const autoRetryEnd = (
  attempt: number,
  success: boolean,
  finalError?: string,
) => ({
  type: "auto_retry_end",
  success,
  attempt,
  ...(finalError === undefined ? {} : { finalError }),
});

const recoveredCompletion = (
  options: {
    readonly stopReason?: "error" | "aborted";
    readonly errorMessage?: string;
    readonly attempt?: number;
  } = {},
) => {
  const stopReason = options.stopReason ?? "error";
  const errorMessage = options.errorMessage ?? "WebSocket error";
  const attempt = options.attempt ?? 1;
  const completion = completionEvidence();
  return [
    assistantEnd({ calls: [], stopReason, errorMessage }),
    agentEnd(true),
    autoRetryStart(attempt, { errorMessage }),
    completion.assistant,
    autoRetryEnd(attempt, true),
    completion.start,
    completion.end,
    agentEnd(false),
    { type: "agent_settled" },
  ];
};

const expectRejectedRetryEvidence = (
  before: ReadonlyArray<unknown>,
  invalid: unknown,
) =>
  Effect.gen(function* () {
    const accumulator = makePiEventAccumulator();
    yield* consumeAll(accumulator, before);
    const rejected = yield* Effect.either(accumulator.consume(line(invalid)));
    expect(Either.isLeft(rejected)).toBe(true);
    if (Either.isLeft(rejected)) {
      expect(rejected.left._tag).toBe("PiEventStreamError");
    }
    expect(
      yield* accumulator.finalize({ code: 0, signal: null }),
    ).toMatchObject({
      status: "failed",
      reason: "Pi event stream contains malformed events",
    });
  });
```

This keeps the successful retry order faithful to Pi 0.80.7: the recovered assistant `message_end` contains the completion call, `auto_retry_end` follows that successful assistant response, and the correlated tool execution result follows recovery.

- [ ] **Step 2: Add successful recovery, diagnostics, and repeated-attempt tests**

Append these tests after `requires agent settlement`:

```ts
it.effect("completes after an explicitly successful provider retry", () =>
  Effect.gen(function* () {
    const accumulator = makePiEventAccumulator();
    yield* consumeAll(accumulator, recoveredCompletion());

    const snapshot = yield* accumulator.snapshot;
    expect(snapshot.providerFailure).toBeUndefined();
    expect(snapshot.recoveredDiagnostics).toEqual([
      "Recovered provider retry attempt 1: WebSocket error",
    ]);
    expect(
      yield* accumulator.finalize({ code: 0, signal: null }),
    ).toMatchObject({
      status: "completed",
      completion: {
        status: "DONE",
        summary: "Implemented parser",
        reportPath: "/tmp/report.md",
      },
    });
  }),
);

it.effect(
  "retains recovered errors only as bounded terminal-safe diagnostics",
  () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      const unsafe =
        "WebSocket \u001b]52;c;SECRET\u0007 error\n" + "detail ".repeat(100);
      yield* consumeAll(
        accumulator,
        recoveredCompletion({ errorMessage: unsafe }),
      );

      const diagnostic = (yield* accumulator.snapshot).recoveredDiagnostics[0];
      expect(diagnostic).toBeDefined();
      if (diagnostic === undefined) return;
      expect(Array.from(diagnostic).length).toBeLessThanOrEqual(500);
      expect(diagnostic).not.toContain("SECRET");
      expect(diagnostic).not.toMatch(/[\r\n\u001b\u0007]/u);
      expect(diagnostic).toContain("Recovered provider retry attempt 1");
    }),
);

it.effect("accepts increasing retry attempts before eventual recovery", () =>
  Effect.gen(function* () {
    const accumulator = makePiEventAccumulator();
    const completion = completionEvidence();
    yield* consumeAll(accumulator, [
      assistantEnd({
        calls: [],
        stopReason: "error",
        errorMessage: "first provider error",
      }),
      agentEnd(true),
      autoRetryStart(1, { errorMessage: "first provider error" }),
      assistantEnd({
        calls: [],
        stopReason: "error",
        errorMessage: "second provider error",
      }),
      agentEnd(true),
      autoRetryStart(2, { errorMessage: "second provider error" }),
      completion.assistant,
      autoRetryEnd(2, true),
      completion.start,
      completion.end,
      agentEnd(false),
      { type: "agent_settled" },
    ]);

    expect(
      yield* accumulator.finalize({ code: 0, signal: null }),
    ).toMatchObject({ status: "completed" });
    expect((yield* accumulator.snapshot).recoveredDiagnostics).toEqual([
      "Recovered provider retry attempt 2: second provider error",
    ]);
  }),
);

it.effect(
  "recovers an aborted provider stop only through the explicit retry lifecycle",
  () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      yield* consumeAll(
        accumulator,
        recoveredCompletion({
          stopReason: "aborted",
          errorMessage: "provider aborted",
        }),
      );

      expect(
        yield* accumulator.finalize({ code: 0, signal: null }),
      ).toMatchObject({ status: "completed" });
      expect((yield* accumulator.snapshot).recoveredDiagnostics).toEqual([
        "Recovered provider retry attempt 1: provider aborted",
      ]);
    }),
);
```

The multiple-attempt test intentionally expects only the latest unresolved stop in the retry chain as the derived diagnostic; earlier raw failures remain authoritative in `events.jsonl`.

- [ ] **Step 3: Add unretried, exhausted, cancelled, malformed, and invalid-order tests**

Replace the existing provider-stop loop and append the strict retry cases:

```ts
for (const stopReason of ["error", "aborted"] as const) {
  it.effect(
    `fails on unretried provider ${stopReason} with exit code zero`,
    () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();
        yield* consumeAll(accumulator, [
          assistantEnd({
            calls: [],
            stopReason,
            errorMessage: `provider ${stopReason}`,
          }),
          agentEnd(false),
          { type: "agent_settled" },
        ]);

        expect(
          yield* accumulator.finalize({ code: 0, signal: null }),
        ).toMatchObject({
          status: "failed",
          reason: `provider ${stopReason}`,
        });
      }),
  );
}

it.effect("keeps retry exhaustion terminal with the final error", () =>
  Effect.gen(function* () {
    const accumulator = makePiEventAccumulator();
    yield* consumeAll(accumulator, [
      assistantEnd({
        calls: [],
        stopReason: "error",
        errorMessage: "first provider error",
      }),
      agentEnd(true),
      autoRetryStart(1, {
        maxAttempts: 1,
        errorMessage: "first provider error",
      }),
      assistantEnd({
        calls: [],
        stopReason: "error",
        errorMessage: "last provider response",
      }),
      agentEnd(false),
      autoRetryEnd(1, false, "provider retry exhausted"),
      { type: "agent_settled" },
    ]);

    expect(
      yield* accumulator.finalize({ code: 0, signal: null }),
    ).toMatchObject({
      status: "failed",
      reason: "provider retry exhausted",
    });
  }),
);

it.effect("keeps a cancelled retry terminal with its final error", () =>
  Effect.gen(function* () {
    const accumulator = makePiEventAccumulator();
    yield* consumeAll(accumulator, [
      assistantEnd({
        calls: [],
        stopReason: "error",
        errorMessage: "WebSocket error",
      }),
      agentEnd(true),
      autoRetryStart(1),
      autoRetryEnd(1, false, "Retry cancelled"),
      { type: "agent_settled" },
    ]);

    expect(
      yield* accumulator.finalize({ code: 0, signal: null }),
    ).toMatchObject({ status: "failed", reason: "Retry cancelled" });
  }),
);

it.effect("rejects malformed recognized retry events permanently", () =>
  Effect.forEach(
    [
      { type: "agent_end", messages: [] },
      { type: "agent_end", messages: "invalid", willRetry: true },
      {
        type: "auto_retry_start",
        attempt: 0,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: "WebSocket error",
      },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 0,
        delayMs: 10,
        errorMessage: "WebSocket error",
      },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: -1,
        errorMessage: "WebSocket error",
      },
      { type: "auto_retry_end", success: true, attempt: 0 },
    ],
    (invalid) => expectRejectedRetryEvidence([], invalid),
    { discard: true },
  ),
);

it.effect(
  "rejects mismatched repeated contradictory and out-of-order retry transitions",
  () => {
    const initialFailure = assistantEnd({
      calls: [],
      stopReason: "error",
      errorMessage: "WebSocket error",
    });
    const secondFailure = assistantEnd({
      calls: [],
      stopReason: "error",
      errorMessage: "second provider error",
    });
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly before: ReadonlyArray<unknown>;
      readonly invalid: unknown;
    }> = [
      {
        name: "retry announcement without failure",
        before: [],
        invalid: agentEnd(true),
      },
      {
        name: "retry start without announcement",
        before: [initialFailure],
        invalid: autoRetryStart(1),
      },
      {
        name: "retry end without an active attempt",
        before: [initialFailure, agentEnd(true)],
        invalid: autoRetryEnd(1, true),
      },
      {
        name: "attempt sequence does not start at one",
        before: [initialFailure, agentEnd(true)],
        invalid: autoRetryStart(2),
      },
      {
        name: "repeated retry start",
        before: [initialFailure, agentEnd(true), autoRetryStart(1)],
        invalid: autoRetryStart(1),
      },
      {
        name: "repeated announcement for the same failure",
        before: [initialFailure, agentEnd(true), autoRetryStart(1)],
        invalid: agentEnd(true),
      },
      {
        name: "mismatched retry end attempt",
        before: [initialFailure, agentEnd(true), autoRetryStart(1)],
        invalid: autoRetryEnd(2, true),
      },
      {
        name: "changed maximum attempts inside one chain",
        before: [
          initialFailure,
          agentEnd(true),
          autoRetryStart(1),
          secondFailure,
          agentEnd(true),
        ],
        invalid: autoRetryStart(2, {
          maxAttempts: 4,
          errorMessage: "second provider error",
        }),
      },
      {
        name: "mismatched retry error message",
        before: [initialFailure, agentEnd(true)],
        invalid: autoRetryStart(1, { errorMessage: "different error" }),
      },
      {
        name: "successful retry carrying finalError",
        before: [initialFailure, agentEnd(true), autoRetryStart(1)],
        invalid: autoRetryEnd(1, true, "contradictory"),
      },
      {
        name: "successful retry after another provider failure",
        before: [
          initialFailure,
          agentEnd(true),
          autoRetryStart(1),
          secondFailure,
        ],
        invalid: autoRetryEnd(1, true),
      },
      {
        name: "settlement before announced retry start",
        before: [initialFailure, agentEnd(true)],
        invalid: { type: "agent_settled" },
      },
      {
        name: "settlement while retry is active",
        before: [initialFailure, agentEnd(true), autoRetryStart(1)],
        invalid: { type: "agent_settled" },
      },
    ];

    return Effect.forEach(
      cases,
      (testCase) =>
        expectRejectedRetryEvidence(testCase.before, testCase.invalid).pipe(
          Effect.withSpan(testCase.name),
        ),
      { discard: true },
    );
  },
);
```

- [ ] **Step 4: Run the accumulator test to verify RED**

Run:

```bash
bun --bun vitest run src/subagents/pi-events.test.ts --reporter dot
```

Expected: FAIL because retry events are still ignored, the sticky provider failure prevents recovered completion, snapshots lack `recoveredDiagnostics`, and malformed recognized retry events do not reject.

- [ ] **Step 5: Add strict retry event schemas and decoders**

In `src/subagents/pi-events.ts`, add these schemas after `ToolEndEventSchema` and add their decoders beside the existing decoder constants:

```ts
const PositiveIntSchema = Schema.Int.pipe(Schema.positive());

const AgentEndEventSchema = Schema.Struct({
  type: Schema.Literal("agent_end"),
  messages: Schema.Array(Schema.Unknown),
  willRetry: Schema.Boolean,
});

const AutoRetryStartEventSchema = Schema.Struct({
  type: Schema.Literal("auto_retry_start"),
  attempt: PositiveIntSchema,
  maxAttempts: PositiveIntSchema,
  delayMs: Schema.NonNegativeInt,
  errorMessage: Schema.String,
});

const AutoRetryEndEventSchema = Schema.Struct({
  type: Schema.Literal("auto_retry_end"),
  success: Schema.Boolean,
  attempt: PositiveIntSchema,
  finalError: Schema.optional(Schema.String),
});
```

```ts
const decodeAgentEnd = Schema.decodeUnknownSync(AgentEndEventSchema);
const decodeAutoRetryStart = Schema.decodeUnknownSync(
  AutoRetryStartEventSchema,
);
const decodeAutoRetryEnd = Schema.decodeUnknownSync(AutoRetryEndEventSchema);
```

Keep normal Effect Schema excess-property behavior for Pi transport events, matching the existing recognized event decoders; only the exact completion tool result remains excess-property strict.

- [ ] **Step 6: Replace sticky-only provider state with explicit retry state**

Extend the existing imports and replace the accumulator provider state/interfaces with:

```ts
import {
  COMPLETION_SUMMARY_MAX_CODE_POINTS,
  type CompletionResult,
  CompletionResultSchema,
  type RunUsage,
} from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";
```

```ts
interface ProviderFailure {
  readonly stopReason: "error" | "aborted";
  readonly message?: string;
}

interface MutableProviderFailure extends ProviderFailure {
  readonly observedAtLine: number;
  retryAnnounced: boolean;
}

interface ActiveRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly sourceFailureLine: number;
  failed: boolean;
}

export interface PiEventAccumulatorSnapshot {
  readonly sessionId?: string;
  readonly usage: RunUsage;
  readonly settled: boolean;
  readonly completion?: CompletionResult;
  readonly completionInvalidated: boolean;
  readonly providerFailure?: ProviderFailure;
  readonly recoveredDiagnostics: ReadonlyArray<string>;
}

interface MutableAccumulatorState {
  lineNumber: number;
  sessionId?: string;
  usage: RunUsage;
  settled: boolean;
  pendingCompletion?: PendingCompletion;
  completion?: CompletionResult;
  completionInvalidated: boolean;
  streamFailed: boolean;
  providerFailure?: MutableProviderFailure;
  retryExpected: boolean;
  activeRetry?: ActiveRetry;
  lastRetryAttempt?: number;
  retryMaxAttempts?: number;
  recoveredDiagnostics: Array<string>;
}
```

Replace `snapshotState` with the same existing fields plus copied public failure and diagnostic evidence:

```ts
const snapshotState = (
  state: MutableAccumulatorState,
): PiEventAccumulatorSnapshot => ({
  ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
  usage: copyUsage(state.usage),
  settled: state.settled,
  ...(state.completion === undefined
    ? {}
    : { completion: copyCompletion(state.completion) }),
  completionInvalidated: state.completionInvalidated,
  ...(state.providerFailure === undefined
    ? {}
    : {
        providerFailure: {
          stopReason: state.providerFailure.stopReason,
          ...(state.providerFailure.message === undefined
            ? {}
            : { message: state.providerFailure.message }),
        },
      }),
  recoveredDiagnostics: [...state.recoveredDiagnostics],
});
```

- [ ] **Step 7: Add bounded diagnostic and retry-transition helpers**

Add these helpers before `consumeValue`:

```ts
const invalidRetryTransition = (message: string): never => {
  throw new Error(`Invalid Pi retry lifecycle: ${message}`);
};

const boundedDiagnostic = (value: string): string => {
  const sanitized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  const nonEmpty = sanitized.length === 0 ? "Provider failure" : sanitized;
  return Array.from(nonEmpty)
    .slice(0, COMPLETION_SUMMARY_MAX_CODE_POINTS)
    .join("");
};

const recoveredProviderDiagnostic = (
  failure: ProviderFailure,
  attempt: number,
): string =>
  boundedDiagnostic(
    `Recovered provider retry attempt ${String(attempt)}: ${
      failure.message ?? `Provider stopped with ${failure.stopReason}`
    }`,
  );

const recordProviderFailure = (
  state: MutableAccumulatorState,
  failure: ProviderFailure,
): void => {
  if (state.retryExpected) {
    invalidRetryTransition("provider failure arrived before retry start");
  }
  if (state.activeRetry !== undefined) {
    state.activeRetry.failed = true;
  }
  state.providerFailure = {
    ...failure,
    observedAtLine: state.lineNumber,
    retryAnnounced: false,
  };
};

const consumeAgentEnd = (
  state: MutableAccumulatorState,
  event: Schema.Schema.Type<typeof AgentEndEventSchema>,
): void => {
  if (state.retryExpected) {
    invalidRetryTransition("agent_end repeated before retry start");
  }

  if (!event.willRetry) {
    if (state.activeRetry !== undefined) {
      const failure = state.providerFailure;
      if (
        !state.activeRetry.failed ||
        failure === undefined ||
        failure.observedAtLine === state.activeRetry.sourceFailureLine
      ) {
        invalidRetryTransition(
          "agent_end ended an active retry before its retry result",
        );
      }
    }
    return;
  }

  const failure = state.providerFailure;
  if (failure === undefined) {
    invalidRetryTransition("retry announced without provider failure");
  }
  if (failure.retryAnnounced) {
    invalidRetryTransition("retry announced repeatedly for one failure");
  }
  if (state.activeRetry !== undefined) {
    if (
      !state.activeRetry.failed ||
      failure.observedAtLine === state.activeRetry.sourceFailureLine
    ) {
      invalidRetryTransition("next retry announced without a new failure");
    }
    state.activeRetry = undefined;
  }

  failure.retryAnnounced = true;
  state.retryExpected = true;
};

const consumeAutoRetryStart = (
  state: MutableAccumulatorState,
  event: Schema.Schema.Type<typeof AutoRetryStartEventSchema>,
): void => {
  const failure = state.providerFailure;
  if (
    !state.retryExpected ||
    state.activeRetry !== undefined ||
    failure === undefined ||
    !failure.retryAnnounced
  ) {
    invalidRetryTransition("retry start has no matching announcement");
  }
  const expectedAttempt = (state.lastRetryAttempt ?? 0) + 1;
  if (event.attempt !== expectedAttempt) {
    invalidRetryTransition(
      `retry attempt ${String(event.attempt)} did not follow ${String(
        state.lastRetryAttempt ?? 0,
      )}`,
    );
  }
  if (event.attempt > event.maxAttempts) {
    invalidRetryTransition("retry attempt exceeds maxAttempts");
  }
  if (
    state.retryMaxAttempts !== undefined &&
    state.retryMaxAttempts !== event.maxAttempts
  ) {
    invalidRetryTransition("maxAttempts changed inside one retry chain");
  }
  if (failure.message !== undefined && failure.message !== event.errorMessage) {
    invalidRetryTransition("retry error does not match provider failure");
  }
  if (failure.message === undefined) {
    state.providerFailure = { ...failure, message: event.errorMessage };
  }

  state.retryExpected = false;
  state.lastRetryAttempt = event.attempt;
  state.retryMaxAttempts = event.maxAttempts;
  state.activeRetry = {
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    sourceFailureLine: failure.observedAtLine,
    failed: false,
  };
};

const consumeAutoRetryEnd = (
  state: MutableAccumulatorState,
  event: Schema.Schema.Type<typeof AutoRetryEndEventSchema>,
): void => {
  const active = state.activeRetry;
  const failure = state.providerFailure;
  if (
    state.retryExpected ||
    active === undefined ||
    failure === undefined ||
    event.attempt !== active.attempt
  ) {
    invalidRetryTransition("retry end does not match the active attempt");
  }

  if (event.success) {
    if (active.failed) {
      invalidRetryTransition("failed retry attempt reported success");
    }
    if (event.finalError !== undefined) {
      invalidRetryTransition("successful retry included finalError");
    }
    state.recoveredDiagnostics.push(
      recoveredProviderDiagnostic(failure, active.attempt),
    );
    state.providerFailure = undefined;
  } else if (event.finalError !== undefined) {
    state.providerFailure = { ...failure, message: event.finalError };
  }

  state.activeRetry = undefined;
  state.lastRetryAttempt = undefined;
  state.retryMaxAttempts = undefined;
};
```

All validation occurs before the corresponding lifecycle mutation. A thrown transition error is caught by the existing `consume` wrapper, marks `streamFailed`, and returns `PiEventStreamError` with line context.

- [ ] **Step 8: Wire provider and retry transitions into `consumeValue`**

Replace the provider assignment inside assistant `message_end` and add recognized retry cases:

```ts
if (
  event.message.stopReason === "error" ||
  event.message.stopReason === "aborted"
) {
  recordProviderFailure(state, {
    stopReason: event.message.stopReason,
    ...(event.message.errorMessage === undefined
      ? {}
      : { message: event.message.errorMessage }),
  });
}
```

```ts
case "agent_end": {
  const event = decodeAgentEnd(value);
  consumeAgentEnd(state, event);
  return { type: "ignored" };
}
case "auto_retry_start": {
  const event = decodeAutoRetryStart(value);
  consumeAutoRetryStart(state, event);
  return { type: "ignored" };
}
case "auto_retry_end": {
  const event = decodeAutoRetryEnd(value);
  consumeAutoRetryEnd(state, event);
  return { type: "ignored" };
}
case "agent_settled": {
  decodeAgentSettled(value);
  if (state.retryExpected || state.activeRetry !== undefined) {
    invalidRetryTransition("agent settled while retry remained pending");
  }
  state.settled = true;
  return { type: "settled" };
}
```

Initialize the new state in `makePiEventAccumulator`:

```ts
const state: MutableAccumulatorState = {
  lineNumber: 0,
  usage: emptyUsage(),
  settled: false,
  completionInvalidated: false,
  streamFailed: false,
  retryExpected: false,
  recoveredDiagnostics: [],
};
```

Keep finalization precedence unchanged: process exit, malformed stream, unresolved `providerFailure`, settlement, invalidated completion, missing completion, then semantic completion. Successful retry works solely because its matched end clears `providerFailure`.

- [ ] **Step 9: Run focused accumulator validation and format checks**

Run:

```bash
bun --bun vitest run src/subagents/pi-events.test.ts --reporter dot
bunx prettier --check \
  src/subagents/pi-events.ts \
  src/subagents/pi-events.test.ts
```

Expected: the accumulator suite and formatting PASS. Existing completion-finality, malformed-message, usage, settlement, provider-stop, and process-exit tests remain green.

- [ ] **Step 10: Commit the retry-aware accumulator slice**

```bash
git add \
  src/subagents/pi-events.ts \
  src/subagents/pi-events.test.ts
git commit -m "fix(subagents): interpret provider retry lifecycle"
```

---

### Task 2: Persist Recovered Diagnostics Through RunExecutor

**Files:**

- Modify: `src/subagents/run-executor.test.ts:158-218,553-610,789-870`
- Modify: `src/subagents/run-executor.ts:546-560`

**Interfaces:**

- Consumes: Task 1's `PiEventAccumulatorSnapshot.recoveredDiagnostics` and the existing `withDiagnostics`, `commitCandidate`, durable fallback, and immutable terminal-winner behavior.
- Produces: every executor-owned terminal candidate carries recovered diagnostics in both `RunStatusRecord.diagnostics` and `RunResult.diagnostics` without changing status, summary, report path, usage, exit data, or fallback precedence.

- [ ] **Step 1: Add an executor-level retry transcript helper**

In `src/subagents/run-executor.test.ts`, add these helpers after `completionEvents`:

```ts
const agentEnd = (willRetry: boolean) => ({
  type: "agent_end",
  messages: [],
  willRetry,
});

const recoveredCompletionEvents = () => {
  const completion = completionEvents();
  const completionAssistant = completion[0];
  const completionTail = completion.slice(1, -1);
  return [
    assistantEnd({
      stopReason: "error",
      errorMessage: "WebSocket error",
    }),
    agentEnd(true),
    {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: "WebSocket error",
    },
    completionAssistant,
    { type: "auto_retry_end", success: true, attempt: 1 },
    ...completionTail,
    agentEnd(false),
    { type: "agent_settled" },
  ];
};
```

The helper reuses the exact correlated completion event objects and inserts successful retry evidence between the completion assistant `message_end` and tool execution.

- [ ] **Step 2: Add a durable semantic-completion regression test**

Append this test after `drains stdout and stderr concurrently, appends raw data first, and returns semantic completion`:

```ts
it.effect(
  "durably commits semantic completion with a recovered provider diagnostic",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* makeFakeRun();
        const process = yield* ProcessServiceTest;
        const handle = yield* launchRun(run.store);

        yield* process.emitLaunch(0);
        yield* handle.launched;
        yield* emitLines(process, 0, recoveredCompletionEvents());
        yield* process.complete(0, { code: 0, signal: null });

        const result = yield* handle.awaitResult;
        const persisted = (yield* run.state).status;
        expect(result).toMatchObject({
          status: "DONE",
          summary: "Review complete",
          reportPath: "/tmp/report.md",
          exitCode: 0,
          signal: null,
          diagnostics: ["Recovered provider retry attempt 1: WebSocket error"],
        });
        expect(persisted).toMatchObject({
          status: "DONE",
          summary: "Review complete",
          reportPath: "/tmp/report.md",
          diagnostics: ["Recovered provider retry attempt 1: WebSocket error"],
        });
        expect(() => decodeRunStatusRecord(persisted)).not.toThrow();
      }),
    ).pipe(Effect.provide(executorLayer)),
);
```

Add this neighboring test to prove the single commit gate also preserves recovery history when later process evidence wins:

```ts
it.effect(
  "retains recovered diagnostics when a later process failure wins",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* makeFakeRun();
        const process = yield* ProcessServiceTest;
        const handle = yield* launchRun(run.store);

        yield* process.emitLaunch(0);
        yield* handle.launched;
        yield* emitLines(process, 0, recoveredCompletionEvents());
        yield* process.emitPostLaunchError(
          0,
          new ProcessError({
            operation: "wait",
            message: "late process failure",
          }),
        );
        yield* process.complete(0, { code: 0, signal: null });

        const result = yield* handle.awaitResult;
        const persisted = (yield* run.state).status;
        expect(result.status).toBe("FAILED");
        expect(result.diagnostics).toContain(
          "Recovered provider retry attempt 1: WebSocket error",
        );
        expect(result.diagnostics.join(" ")).toContain("late process failure");
        expect(persisted.status).toBe("FAILED");
        expect(persisted.diagnostics).toContain(
          "Recovered provider retry attempt 1: WebSocket error",
        );
      }),
    ).pipe(Effect.provide(executorLayer)),
);
```

Keep the existing `provider error` case in `maps every invalid terminal event/process outcome to FAILED` unchanged as unretried regression coverage.

- [ ] **Step 3: Run the executor test to verify RED**

Run:

```bash
bun --bun vitest run src/subagents/run-executor.test.ts --reporter dot
```

Expected: the new test FAILS because the accumulator diagnostic exists only in its snapshot and the executor commits an empty diagnostic list for the semantic result.

- [ ] **Step 4: Merge recovered diagnostics at the single terminal commit gate**

In `src/subagents/run-executor.ts`, replace the local `commitTerminal` function with:

```ts
const commitTerminal = (
  candidate: TerminalCandidate,
): Effect.Effect<RunResult, RunStoreError> =>
  Deferred.await(terminalGate).pipe(
    Effect.zipRight(accumulator.snapshot),
    Effect.flatMap((snapshot) =>
      commitCandidate(
        task,
        run,
        withDiagnostics(candidate, snapshot.recoveredDiagnostics),
      ),
    ),
  );
```

Do not add recovered diagnostics inside `finalizationCandidate`: the commit gate covers semantic finalization plus post-recovery store, stream, process, output-drain, and shutdown failures exactly once. Existing `commitCandidate` then preserves the merged values if a semantic terminal write falls back to `FAILED` or loses to a durable terminal winner.

- [ ] **Step 5: Run focused executor and accumulator validation**

Run:

```bash
bun --bun vitest run \
  src/subagents/pi-events.test.ts \
  src/subagents/run-executor.test.ts \
  --reporter dot
bunx prettier --check \
  src/subagents/run-executor.ts \
  src/subagents/run-executor.test.ts
```

Expected: both suites and formatting PASS. The returned result and fake durable record contain the same recovered diagnostic, while the existing unretried provider error remains `FAILED`.

- [ ] **Step 6: Commit executor propagation**

```bash
git add \
  src/subagents/run-executor.ts \
  src/subagents/run-executor.test.ts
git commit -m "fix(subagents): persist recovered retry diagnostics"
```

---

### Task 3: Prove the Retry Sequence Through a Real Child Process

**Files:**

- Modify: `test/fixtures/fake-pi.ts:4,172-193,337-429,478-510`
- Modify: `src/subagents/subagents.integration.test.ts:1-29,323-547,724-861,1081-1114`
- Modify: `docs/specs/subagents.md:35-39`

**Interfaces:**

- Consumes: Tasks 1–2, the fake executable selector, live `ProcessService`, private `RunStore`, completion/result rendering, and existing report-path schema.
- Produces: one credential-free process transcript proving raw retry evidence becomes durable `DONE`, report data, and expanded-only diagnostics; updates the owning living contract.

- [ ] **Step 1: Extend fake-Pi completion options without changing existing modes**

In `test/fixtures/fake-pi.ts`, replace the filesystem import with:

```ts
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
```

Add `"retry-success"` to the supported mode list:

```ts
    "success",
    "retry-success",
    "blocked",
```

Then replace `assistantMessage`/`emitCompletion` with:

```ts
const assistantMessage = (
  content: ReadonlyArray<unknown>,
  stopReason: "stop" | "toolUse" | "error",
  timestamp: number,
  usage: typeof finalUsage,
  errorMessage?: string,
) => ({
  role: "assistant",
  content,
  api: "fake-pi-json",
  provider: "fake-provider",
  model: "fake-model",
  usage,
  stopReason,
  timestamp,
  ...(errorMessage === undefined ? {} : { errorMessage }),
});

interface CompletionOptions {
  readonly reportPath?: string;
  readonly afterAssistantEnd?: () => void;
}

const emitCompletion = (
  status: "DONE" | "BLOCKED",
  summary: string,
  options: CompletionOptions = {},
): void => {
  const assistantTimestamp = Date.now();
  const toolCallId = `complete-${id}`;
  const argumentsValue = {
    status,
    summary,
    ...(options.reportPath === undefined
      ? {}
      : { reportPath: options.reportPath }),
  };
  const toolCall = {
    type: "toolCall",
    id: toolCallId,
    name: "complete_subagent",
    arguments: argumentsValue,
  };
  const assistantStart = assistantMessage(
    [],
    "toolUse",
    assistantTimestamp,
    emptyUsage,
  );
  const assistantEnd = assistantMessage(
    [toolCall],
    "toolUse",
    assistantTimestamp,
    finalUsage,
  );
  emit({ type: "message_start", message: assistantStart });
  emit({
    type: "message_update",
    message: assistantEnd,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall,
      partial: assistantEnd,
    },
  });
  emit({ type: "message_end", message: assistantEnd });
  options.afterAssistantEnd?.();
  emit({
    type: "tool_execution_start",
    toolCallId,
    toolName: "complete_subagent",
    args: argumentsValue,
  });
  const completionResult = {
    content: [
      { type: "text", text: `Subagent completion recorded: ${status}` },
    ],
    details: argumentsValue,
    terminate: true,
  };
  emit({
    type: "tool_execution_end",
    toolCallId,
    toolName: "complete_subagent",
    result: completionResult,
    isError: false,
  });
  const toolResultMessage = {
    role: "toolResult",
    toolCallId,
    toolName: "complete_subagent",
    content: completionResult.content,
    details: completionResult.details,
    isError: false,
    timestamp: Date.now(),
  };
  emit({ type: "message_start", message: toolResultMessage });
  emit({ type: "message_end", message: toolResultMessage });
  emit({
    type: "turn_end",
    message: assistantEnd,
    toolResults: [toolResultMessage],
  });
  emit({
    type: "agent_end",
    messages: [userMessage, assistantEnd, toolResultMessage],
    willRetry: false,
  });
  emit({ type: "agent_settled" });
};
```

Existing calls still omit options, so their exact completion arguments/results and `assertStrictCompletionProtocol` expectations remain unchanged.

- [ ] **Step 2: Add the fake retry-success transcript**

Add this helper after `emitCompletion`:

```ts
const emitRetrySuccess = (): void => {
  const errorMessage = "WebSocket error";
  const assistantTimestamp = Date.now();
  const failedStart = assistantMessage(
    [],
    "error",
    assistantTimestamp,
    emptyUsage,
    errorMessage,
  );
  const failedEnd = assistantMessage(
    [],
    "error",
    assistantTimestamp,
    finalUsage,
    errorMessage,
  );
  emit({ type: "message_start", message: failedStart });
  emit({ type: "message_end", message: failedEnd });
  emit({ type: "turn_end", message: failedEnd, toolResults: [] });
  emit({
    type: "agent_end",
    messages: [userMessage, failedEnd],
    willRetry: true,
  });
  emit({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 10,
    errorMessage,
  });

  const reportPath = path.join(runDirectory, "retry-report.md");
  writeFileSync(reportPath, `# Retry report\n\nRecovered fake child ${id}.\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  emitCompletion("DONE", `Fake Pi recovered ${id}`, {
    reportPath,
    afterAssistantEnd: () =>
      emit({ type: "auto_retry_end", success: true, attempt: 1 }),
  });
};
```

Add the switch branch:

```ts
case "retry-success":
  emitRetrySuccess();
  break;
```

The resulting JSONL order is: failed assistant stop, retrying `agent_end`, retry start, successful completion assistant message, retry success, correlated completion result, final non-retrying `agent_end`, settlement, and natural exit zero.

- [ ] **Step 3: Add integration rendering imports and a neutral theme**

In `src/subagents/subagents.integration.test.ts`, add:

```ts
import {
  formatModelResult,
  renderSubagentResult,
  type RenderTheme,
} from "./render";
```

Near the fixture constants add:

```ts
const renderTheme: RenderTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};
```

- [ ] **Step 4: Add the real-process retry acceptance test**

Append this test after `runs one successful child with strict completion and private artifacts`:

```ts
it.effect(
  "recovers a provider retry through JSONL durable status and ordered rendering",
  () =>
    runTest((sandbox) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const [result] = yield* execute(
          { tasks: [task("alpha", "retry-success", "retry-ok", 0)] },
          sandbox,
        );
        expect(result).toBeDefined();
        if (result === undefined) return;

        const diagnostic =
          "Recovered provider retry attempt 1: WebSocket error";
        const reportPath = path.join(
          result.artifacts.runDirectory,
          "retry-report.md",
        );
        expect(result).toMatchObject({
          agent: "alpha",
          status: "DONE",
          summary: "Fake Pi recovered retry-ok",
          reportPath,
          exitCode: 0,
          signal: null,
          diagnostics: [diagnostic],
        });
        expect(yield* fileSystem.readTextFile(reportPath)).toContain(
          "Recovered fake child retry-ok",
        );

        const persisted = decodeRunStatusRecordJson(
          yield* fileSystem.readTextFile(result.artifacts.statusPath),
        );
        expect(persisted).toMatchObject({
          status: "DONE",
          summary: "Fake Pi recovered retry-ok",
          reportPath,
          diagnostics: [diagnostic],
        });

        const rawEvents = yield* fileSystem.readTextFile(
          result.artifacts.eventsPath,
        );
        const events = parseJsonLines(rawEvents);
        expect(
          events.map((event) =>
            isJsonObject(event) && typeof event.type === "string"
              ? event.type
              : "invalid",
          ),
        ).toEqual([
          "session",
          "agent_start",
          "turn_start",
          "message_start",
          "message_end",
          "message_start",
          "message_end",
          "turn_end",
          "agent_end",
          "auto_retry_start",
          "message_start",
          "message_update",
          "message_end",
          "auto_retry_end",
          "tool_execution_start",
          "tool_execution_end",
          "message_start",
          "message_end",
          "turn_end",
          "agent_end",
          "agent_settled",
        ]);
        expect(messageObject(eventObject(events, 6))).toMatchObject({
          role: "assistant",
          stopReason: "error",
          errorMessage: "WebSocket error",
        });
        expect(eventObject(events, 8)).toMatchObject({
          type: "agent_end",
          willRetry: true,
        });
        expect(eventObject(events, 9)).toEqual({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 10,
          errorMessage: "WebSocket error",
        });
        expect(eventObject(events, 13)).toEqual({
          type: "auto_retry_end",
          success: true,
          attempt: 1,
        });
        expect(eventObject(events, 19)).toMatchObject({
          type: "agent_end",
          willRetry: false,
        });
        expect(eventObject(events, 20)).toEqual({
          type: "agent_settled",
        });
        expect(rawEvents).toContain('"errorMessage":"WebSocket error"');

        const modelText = formatModelResult([result]);
        const collapsed = renderSubagentResult(
          {
            content: [{ type: "text", text: modelText }],
            details: {
              phase: "complete",
              results: [result],
              diagnostics: [],
            },
          },
          { expanded: false, isPartial: false },
          renderTheme,
        )
          .render(200)
          .join("\n");
        const expanded = renderSubagentResult(
          {
            content: [{ type: "text", text: modelText }],
            details: {
              phase: "complete",
              results: [result],
              diagnostics: [],
            },
          },
          { expanded: true, isPartial: false },
          renderTheme,
        )
          .render(200)
          .join("\n");

        expect(modelText).toContain("DONE: Fake Pi recovered retry-ok");
        expect(modelText).toContain(reportPath);
        expect(modelText).not.toContain("WebSocket error");
        expect(collapsed).not.toContain("WebSocket error");
        expect(expanded).toContain(`diagnostic: ${diagnostic}`);
      }),
    ),
);
```

This test uses the product path—live child process, stdout/stderr draining, raw append, accumulator, terminal candidate, atomic status write, result rendering—rather than duplicating the unit-level event injection.

- [ ] **Step 5: Run the integration test to verify RED**

Run:

```bash
bun --bun vitest run \
  src/subagents/subagents.integration.test.ts \
  --reporter dot \
  -t "recovers a provider retry through JSONL durable status and ordered rendering"
```

Expected: FAIL before the fixture changes because `retry-success` is unsupported; after only fixture changes it still fails unless Tasks 1–2 correctly recover and durably propagate the diagnostic.

- [ ] **Step 6: Update the owning completion/finality contract**

In `docs/specs/subagents.md`, replace the final provider-failure sentence in **Completion and Finality** with this contract-level wording:

```md
A semantic result is accepted only when exactly one `complete_subagent` call is the sole tool call in its assistant message, its successful exact tool result correlates by call ID, no later assistant or unrelated tool work invalidates it, the agent settles, and the process exits successfully. Child runtime is unbounded, while output draining after the direct child exits has one shared deadline so a descendant retaining inherited descriptors cannot keep a run active forever. Output that drains within that deadline is processed normally; expiry releases local output ownership and produces `FAILED` with the known exit and a truncation diagnostic, even if semantic completion was previously observed. An output stream failure initiates bounded process cleanup immediately rather than waiting indefinitely for natural exit.

An unrecovered or final provider error or aborted stop produces `FAILED`. A provider failure followed by a valid Pi-confirmed successful automatic retry is retained as non-fatal diagnostic evidence and does not override a later valid settled structured completion. Malformed or invalidly ordered recognized retry lifecycle events, malformed non-empty JSON, stream or process failures, missing settlement or completion, unsuccessful exits, and truncated post-exit evidence produce `FAILED`. Raw completion transport is not trusted as final merely because it appeared once.
```

Do not duplicate the rendering rule: **Progress, Privacy, and Results** already states that diagnostics appear only in expanded details and are absent from model-facing text.

- [ ] **Step 7: Run focused process, regression, formatting, and full checks**

Run:

```bash
bun --bun vitest run \
  src/subagents/pi-events.test.ts \
  src/subagents/run-executor.test.ts \
  src/subagents/subagents.integration.test.ts \
  --reporter dot
bunx prettier --check \
  src/subagents/pi-events.ts \
  src/subagents/pi-events.test.ts \
  src/subagents/run-executor.ts \
  src/subagents/run-executor.test.ts \
  test/fixtures/fake-pi.ts \
  src/subagents/subagents.integration.test.ts \
  docs/specs/subagents.md
bun run check
```

Expected: focused event/executor/integration suites PASS, formatting PASS, and `bun run check` reports typecheck, lint, and all test files passing. Existing success, blocked, malformed, missing-completion, nonzero, retained-output, launch rollback, cancellation, and strict transcript tests remain green.

- [ ] **Step 8: Commit process acceptance and the living specification**

```bash
git add \
  test/fixtures/fake-pi.ts \
  src/subagents/subagents.integration.test.ts \
  docs/specs/subagents.md
git commit -m "test(subagents): verify recovered provider retry"
```

---

### Task 4: Verify and Review the Complete Change

**Files:**

- Review: all files changed since `4d9f604243854562bf9d81a0bb272563584322ce`
- Review: `docs/superpowers/specs/2026-07-16-retry-aware-subagent-finalization-design.md`
- Review: `docs/specs/subagents.md`

**Interfaces:**

- Consumes: committed Tasks 1–3.
- Produces: evidence that every approved retry, finality, durability, privacy, and non-goal requirement is satisfied without weakening existing behavior.

- [ ] **Step 1: Run focused feature validation from a clean worktree**

Run:

```bash
git status --short
bun --bun vitest run \
  src/subagents/pi-events.test.ts \
  src/subagents/run-executor.test.ts \
  src/subagents/render.test.ts \
  src/subagents/run-store.test.ts \
  src/subagents/subagents.integration.test.ts \
  --reporter dot
```

Expected: `git status --short` is empty and every selected suite passes.

- [ ] **Step 2: Run repository-wide verification**

Run:

```bash
bun run check
bunx prettier --check \
  src/subagents/pi-events.ts \
  src/subagents/pi-events.test.ts \
  src/subagents/run-executor.ts \
  src/subagents/run-executor.test.ts \
  test/fixtures/fake-pi.ts \
  src/subagents/subagents.integration.test.ts \
  docs/specs/subagents.md
git diff --check 4d9f604243854562bf9d81a0bb272563584322ce..HEAD
```

Expected: typecheck, lint, all tests, formatting, and whitespace validation PASS.

- [ ] **Step 3: Audit the targeted diff against every approved requirement**

Run:

```bash
git diff --stat 4d9f604243854562bf9d81a0bb272563584322ce..HEAD
git diff --name-only 4d9f604243854562bf9d81a0bb272563584322ce..HEAD
git diff 4d9f604243854562bf9d81a0bb272563584322ce..HEAD -- \
  src/subagents/pi-events.ts \
  src/subagents/pi-events.test.ts \
  src/subagents/run-executor.ts \
  src/subagents/run-executor.test.ts \
  test/fixtures/fake-pi.ts \
  src/subagents/subagents.integration.test.ts \
  docs/specs/subagents.md
```

Confirm from the diff, not from memory:

1. Recognized retry events are strict while unknown future event types remain ignored.
2. Provider failures stay unresolved until a matching explicit retry success; ordinary later work cannot clear them.
3. Attempt numbering, max-attempt consistency, matching starts/ends, repeated announcements, contradictions, and settlement ordering fail closed.
4. Single and multiple provider failures can recover; unretried, exhausted, cancelled, and unresolved aborted stops remain terminal.
5. Recovered diagnostics are bounded, terminal-safe, single-line, durable, and appended exactly once to every later executor terminal candidate.
6. Semantic status, summary, report path, completion correlation, usage, process exit/drain, status fallback, cancellation, and terminal-winner rules remain unchanged.
7. Raw JSONL retains the original provider error and exact retry sequence without sanitization or rewriting.
8. Returned results and `status.json` retain recovered diagnostics; model-facing and collapsed output omit them; expanded details render them.
9. The fake process creates a real private report file and exits naturally after final `agent_settled`.
10. No dependency, package surface, redispatch, rollback, worktree, artifact-reconciliation, idempotency, or milestone-two behavior was added.
11. `docs/specs/subagents.md` accurately states the corrected provider-finality contract without implementation detail; no other living spec requires change.

- [ ] **Step 4: Review the complete branch against `main` as required by repository policy**

Run:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
git status --short --branch
```

Map every changed domain in the full branch to `docs/specs/index.md`. Confirm the existing branch specifications for architecture, extensions, file system, process service, test services, and Subagents remain accurate, and that this feature changes only the already committed `docs/specs/subagents.md` contract. Expected: no untracked/staged files and no `.context/` changes.

- [ ] **Step 5: Request an independent code review**

Use `superpowers:requesting-code-review` with this review contract:

```text
Review 4d9f604243854562bf9d81a0bb272563584322ce..HEAD against
`docs/superpowers/specs/2026-07-16-retry-aware-subagent-finalization-design.md`.
Check strict Pi 0.80.7 retry schemas, lifecycle ordering, repeated-attempt
progression, explicit-only recovery, unresolved failure precedence, bounded
sanitized diagnostics, universal terminal-candidate propagation, durable status,
raw JSONL fidelity, report validation, rendering privacy, and regressions in
completion/process/store/cancellation behavior. Report only evidence-backed
findings with file and line references; do not modify files.
```

Expected: no unresolved blocker or correctness finding. If review finds a defect, keep the task open, add a failing regression test, apply the smallest fix, rerun Steps 1–4, and commit the fix with a focused message before completion.
