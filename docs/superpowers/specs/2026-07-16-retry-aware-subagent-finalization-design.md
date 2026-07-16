# Retry-Aware Subagent Finalization Design

**Date:** 2026-07-16

**Status:** Approved

**Scope:** Correct Pi-internal provider retry interpretation in the lightweight Subagents extension

## Problem

The Subagents event accumulator currently treats every assistant `message_end` with `stopReason: "error" | "aborted"` as a permanent provider failure. Pi can automatically recover from a transient provider error, but the accumulator ignores Pi's retry lifecycle events and retains the superseded error through finalization.

The observed run established the failure mode:

1. The child received a `WebSocket error`.
2. Pi emitted `agent_end` with `willRetry: true` and started an automatic retry.
3. Pi emitted `auto_retry_end` with `success: true` after recovery.
4. The child committed its work, validated it, wrote its report, and returned a valid correlated `complete_subagent` result with `DONE`.
5. Pi emitted final `agent_end` with `willRetry: false`, then `agent_settled`, and exited successfully.
6. The extension nevertheless committed `FAILED: WebSocket error` because the earlier provider failure remained sticky.

This is a false terminal failure. Pi defines `agent_end` as the end of one low-level run and `agent_settled` as session-level finality after retries, compaction recovery, and queued continuations have finished.

## Goals

- Interpret Pi's automatic provider retry lifecycle explicitly.
- Accept a valid settled structured completion after Pi confirms that a transient provider failure recovered.
- Preserve recovered provider errors as non-fatal durable diagnostics.
- Keep unretried, exhausted, cancelled, aborted, malformed, and otherwise unresolved provider failures terminal.
- Preserve all existing structured-completion, process, stream, report, settlement, and status-commit guarantees.

## Non-Goals

This change does not add:

- Git baseline or post-run state capture;
- automatic artifact reconciliation;
- retry or idempotency keys;
- worktree creation or commit promotion;
- external redispatch controls;
- transactional guarantees for child side effects; or
- milestone-two management APIs.

A genuinely failed child may already have changed files, created commits, or performed external actions. Correct retry interpretation does not imply rollback or make arbitrary redispatch safe.

## Retry Event Contract

The accumulator will strictly decode the Pi retry events it relies on:

- `agent_end`, including `messages` and `willRetry`;
- `auto_retry_start`, including attempt, maximum attempts, delay, and error message; and
- `auto_retry_end`, including success, attempt, and optional final error.

Recognized retry events with missing, malformed, contradictory, mismatched, or invalidly ordered data are event-stream failures. Unknown future event types remain ignored under the existing forward-compatibility rule.

## State Model

The accumulator will distinguish:

- the latest unresolved provider failure;
- whether Pi announced that the failed low-level run will retry;
- the active retry attempt, when one has started;
- the last observed retry attempt for sequence validation; and
- recovered provider failures retained for non-fatal diagnostics.

A provider `aborted` stop remains terminal unless Pi explicitly emits a supported, valid recovery lifecycle for it. The implementation must not infer recovery merely from later unrelated work.

## State Transitions

### Initial provider failure

An assistant `message_end` with `stopReason: "error" | "aborted"` records the latest unresolved provider failure. It does not immediately elect the run's terminal status because Pi may still announce a retry.

### No retry

`agent_end { willRetry: false }` leaves the unresolved provider failure terminal. Final settlement with that unresolved failure produces `FAILED` under the existing precedence rules.

### Retry announcement and start

`agent_end { willRetry: true }` changes the unresolved failure to retry-expected state. A matching `auto_retry_start` begins the reported attempt. Attempt numbers must be valid and progress consistently across repeated failures.

A retry announcement or start without the required unresolved failure and valid predecessor state is malformed protocol evidence rather than permission to clear an error.

### Successful retry

`auto_retry_end { success: true }` for the active attempt resolves the provider failure. The recovered error moves to non-fatal diagnostics and cannot override a later valid structured completion.

Recovery is based on Pi's explicit retry result, not on a heuristic such as observing any later successful assistant message.

### Failed or cancelled retry

`auto_retry_end { success: false }` leaves a terminal unresolved failure. When `finalError` is present, it becomes the preferred terminal diagnostic. Retry exhaustion without a successful retry result likewise leaves the latest provider failure unresolved.

### Settlement

`agent_settled` remains the required session-level finality signal. A semantic completion is accepted only when all existing requirements still hold and no unresolved provider failure remains.

## Completion and Failure Precedence

The change does not weaken finality. Successful semantic completion still requires:

- exactly one `complete_subagent` call as the sole tool call in its assistant message;
- an exact successful result correlated by tool-call ID;
- no later assistant or unrelated tool work that invalidates completion;
- `agent_settled`; and
- successful process exit with fully drained valid evidence.

The following remain terminal failures:

- unretried provider error;
- exhausted or cancelled retry;
- unresolved provider abort;
- malformed recognized retry event or transition;
- malformed JSON or recognized Pi event;
- output stream or process failure;
- unsuccessful process exit or signal;
- missing settlement or structured completion;
- invalidated completion;
- invalid report evidence;
- truncated post-exit output; and
- run-store failure under the existing durable fallback rules.

## Diagnostics and Rendering

A recovered failure will produce a bounded, sanitized diagnostic such as:

```text
Recovered provider retry attempt 1: WebSocket error
```

Recovered retry diagnostics are retained in terminal structured details and the durable status record. They render only in expanded details under the existing diagnostics policy. They do not change the semantic status, completion summary, report path, or concise model-facing result.

Raw JSONL remains the authoritative unmodified transport evidence.

## Implementation Boundaries

Expected production changes are limited to:

- `src/subagents/pi-events.ts` for schemas and retry-aware accumulation;
- `src/subagents/run-executor.ts` for propagating recovered diagnostics into the existing terminal candidate path; and
- the owning Subagents specification for the corrected provider-finality contract.

Expected test and fixture changes are limited to:

- `src/subagents/pi-events.test.ts`;
- `src/subagents/run-executor.test.ts`;
- `test/fixtures/fake-pi.ts`; and
- `src/subagents/subagents.integration.test.ts`.

No `.context` files will change.

## Test Design

Tests must cover:

1. One provider WebSocket failure followed by a successful automatic retry and valid completion.
2. Multiple provider failures followed by eventual successful retry.
3. Recovered errors retained only as non-fatal diagnostics.
4. Unretried provider error remaining `FAILED`.
5. Retry exhaustion remaining `FAILED` with the latest provider error.
6. Retry cancellation remaining `FAILED` with its final error.
7. Provider abort remaining terminal without an explicit supported recovery sequence.
8. Missing, malformed, mismatched, repeated, or out-of-order recognized retry events failing safely.
9. RunExecutor durably committing semantic status, summary, report path, and recovered diagnostic after recovery.
10. A real fake-Pi process emitting the retry sequence through JSONL, process handling, completion correlation, status publication, and ordered result rendering.

Existing unretried provider-error and completion-finality tests remain required regression coverage.

## Acceptance

This sequence:

```text
assistant WebSocket error
agent_end willRetry:true
auto_retry_start
auto_retry_end success:true
valid complete_subagent DONE
final agent_end willRetry:false
agent_settled
process exit 0
```

must durably produce `DONE` with the child's summary and report path. The recovered WebSocket error must appear only as a non-fatal expanded diagnostic.

Focused event, executor, and integration tests must pass, followed by `bun run check`.

## Specification Impact

Implementation changes the documented completion/finality contract and therefore must update `docs/specs/subagents.md` in the same code change. The specification should state that only an unrecovered or final provider stop produces `FAILED`; a Pi-confirmed successful automatic retry is historical diagnostic evidence rather than a terminal outcome.
