# Attention Hooks

## Purpose

The attention-hooks extension plays an audio cue for settled runs and reported subagent attention. In an eligible tmux session, it also marks the exact pane that is waiting after a settled run, during a standard or opted-in custom dialog, or after reported subagent attention.

## Attention State

Interactive root TUI sessions maintain independent settled-run, standard-dialog, subagent-attention, and opt-in custom-dialog reasons. The tmux pane marker is present while any reason remains active.

A submitted input or new agent run clears settled-run and subagent-attention reasons. Starting a standard or custom dialog also consumes those passive reasons before adding its wait. Standard waits end when their dialog promise settles; custom waits end only through their matching event.

## Completion and Subagent Triggers

A low-level agent outcome is recorded at `agent_end` but never notifies by itself. `agent_settled` consumes the latest recorded outcome, plays once, and sets settled-run attention when its final assistant message is not aborted. A settled run without a recorded assistant outcome is silent and unmarked. A new agent run clears stale outcome and passive attention reasons, and later retries replace earlier outcomes.

A validated `subagent:control-event` whose nested event type is `needs_attention` independently plays audio and sets subagent attention. Null, malformed, and unrelated control payloads are ignored.

User-initiated aborted outcomes remain silent and unmarked.

## Child Suppression

Child-status suppression applies to completion audio, control-event audio, tmux marking, and standard-dialog observation only when `PI_SUBAGENT_CHILD` is exactly `1`. Other values do not identify a child; the separate TUI and pane eligibility rules still apply to tmux behavior.

## Dialog Observation

In interactive root TUI sessions, attention-hooks observes extension calls to `select`, `confirm`, `input`, and `editor`. It marks before invoking the dialog and releases that invocation's wait after success, cancellation, or failure. Overlapping calls retain attention until the final wait ends.

Custom components opt in through `attention-hooks:user-input-wait` with `{ state: "start", id: non-empty string }` and `{ state: "end", id: non-empty string }`. Identifiers are session-scoped. Duplicate starts and ends are idempotent, unknown ends and malformed payloads are ignored, and simultaneous callers use distinct namespaced identifiers.

Cleanup restores an owned standard-dialog method when it is still the active method. If another extension composed around the method, the owned wrapper becomes inert instead of replacing the other extension's wrapper.

## Tmux Marker

Tmux marking is enabled only in TUI mode for a process whose `PI_SUBAGENT_CHILD` is not exactly `1` and whose inherited `TMUX` and `TMUX_PANE` values are valid. `TMUX` is parsed from right to left at its final two commas so its socket path may itself contain commas. The socket path must be non-empty, while the server PID and discarded session ID must each contain one or more ASCII decimal digits. `TMUX_PANE` must be `%` followed by one or more ASCII decimal digits.

The marker path is exactly `<socket-path>.tmux-attention-v1-<server-pid>-<pane-digits>`, with the pane's `%` prefix removed. Its presence signals active attention and is represented by a zero-byte regular file owned by the current user with mode `0600`; its absence signals no attention. The captured marker identity remains stable when window or pane indexes change.

Marker transitions are serialized, including across caller interruption, so a completed publication result is reconciled before a newer desired state. Successful duplicate transitions are skipped, while failed transitions remain retryable.

The extension never accesses the tmux socket. Tmux rendering and configuration belong to the consumer tmux repository, which interprets the versioned marker-file contract.

## Sound Resolution and Playback

The extension resolves the Pi agent directory through the shared agent-directory contract and looks for `vittemacop-alert-notification-pop-cartoon-bubble-pop-pop-up-478078.mp3` directly beneath it. Missing files are silent. Existing files are played through the process service's detached operation using `afplay` and ignored standard I/O, so playback exposes no managed lifecycle handle and does not hold Pi open.

## Failure Handling

Sound lookup and audio launch failures are best-effort and remain silent. Invalid tmux environment values disable marker publication. Marker-file publication or removal failures, listener release, wrapper cleanup, and marker cleanup failures do not fail an extension lifecycle event, alter a dialog result, suppress otherwise eligible audio, or prevent Pi shutdown.

Initial and shutdown marker removal are best-effort. If Pi exits without session shutdown, the next eligible session for the same marker identity attempts to remove the stale marker at session start.

## Lifecycle Disposal

The control-event and custom-wait subscriptions begin at `session_start`. Standard-dialog observation begins there only for an interactive root TUI session. A repeated session start replaces the previously owned listeners, wrappers, work, reasons, and marker state. The factory starts no background resource.

Session start clears logical state and attempts to remove the marker before observers become active. Session shutdown disables callbacks, releases listeners and wrappers, interrupts and joins owned work, clears all reasons, attempts to remove the marker, and then disposes the managed runtime. Cleanup is idempotent, and stale callbacks cannot start audio or marker work after shutdown.

[Process Service](./process-service.md) remains the audio-playback boundary only. [File System Service](./file-system.md) owns private marker publication and removal.
