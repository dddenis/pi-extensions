# Attention Hooks

## Purpose

The attention-hooks extension plays an audio cue when Pi has finished a run that can notify the user or when another extension reports that a subagent needs attention.

## Triggers

- A low-level agent outcome is recorded at `agent_end` but never plays sound by itself.
- `agent_settled` consumes the latest recorded outcome and plays once when its final assistant message is not aborted.
- A settled run without a recorded assistant outcome is silent.
- A new agent run clears any stale outcome, and later retries replace earlier outcomes.
- A valid `subagent:control-event` whose nested event type is `needs_attention` plays independently of agent completion.

## Child Suppression

All completion and control-event audio is suppressed only when `PI_SUBAGENT_CHILD` is exactly `1`. Other values do not suppress notifications.

## Sound Resolution and Playback

The extension resolves the Pi agent directory using the shared agent-directory contract, then looks for `vittemacop-alert-notification-pop-cartoon-bubble-pop-pop-up-478078.mp3` directly beneath it. Missing files are silent. Existing files are played through the shared process service's explicit detached operation using `afplay` and ignored standard I/O, so playback exposes no managed lifecycle handle and does not hold Pi open.

Sound lookup, process launch, asynchronous child failure, and detachment failures are best-effort and never fail an extension lifecycle event.

## Control-Event Validation

Control-event payloads are validated before use. Null, malformed, and unrelated payloads are ignored without playback or failure.

## Lifecycle Disposal

The control-event subscription begins at `session_start`. A repeated session start replaces and unsubscribes the previously owned listener. The factory starts no background resource.

At `session_shutdown`, the extension unsubscribes its listener, clears any pending outcome, interrupts and joins listener-owned Effect fibers, and then disposes its managed runtime. Cleanup is idempotent, and events cannot start playback after shutdown. [Process Service](./process-service.md) owns the shared process lifecycle contract.
