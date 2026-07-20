# Process Service

## Purpose

The process service gives extensions a typed Effect boundary for child processes without exposing Node child-process objects. This keeps process lifecycle, errors, streams, and cleanup owned by shared infrastructure rather than individual extensions.

[Architecture](./architecture.md) owns repository placement and TypeScript boundaries. [Test Services](./test-services.md) owns the reusable fake conventions used to test process consumers.

## Spawn Boundary

- Callers provide a command, arguments, and explicit process options.
- Managed processes are acquired in an Effect scope with a fixed shutdown policy, so leaving the scope always invokes shared bounded cleanup.
- Intentionally fire-and-forget processes use a separate detached operation that owns ignored standard I/O and unref behavior without exposing a lifecycle handle.
- Arguments and environment values are copied before crossing the process boundary so later caller mutation cannot change the launched process.
- Spawn, standard-input, stream, wait, signal, and unref failures use the typed process error contract.
- Ignored standard I/O still retains terminal-event ownership while exposing empty output streams.

## Standard Input

Requesting EOF is distinct from waiting for buffered standard input to finish. EOF initiation is idempotent, and its completion or failure is replayable. Operational callers may await confirmed completion, while managed shutdown waits only within its configured standard-input bound before continuing termination.

## Output and Terminal Result

- Standard output and standard error are exposed as incrementally decoded UTF-8 chunks. Decoder state spans underlying byte chunks so split code points are preserved, including final decoder output at clean end-of-stream.
- Output delivery is bounded and backpressured on both streams so unread bursts cannot create unbounded retained chunks at the service boundary; readers resume as consumers advance.
- Consumers own any protocol-specific framing over decoded chunks rather than imposing line buffering on every process.
- A process has one terminal result, completed by its first exit or a failure before successful spawn. Post-spawn process errors are recorded but do not prove termination or suppress later signal escalation. Waiting is replayable, so every evaluation observes the same exit or pre-spawn failure.

## Termination Ownership

Managed shutdown is idempotent and single-flight. It first requests EOF, then requests graceful termination and waits only for the configured graceful bound. If the process remains active, cleanup requests forced termination and waits only for the configured forced bound. Every phase is also constrained by one total deadline, so signal failures, stalled standard input, scheduler delay, and a missing terminal event cannot make cleanup wait forever.

Finalization is infallible and cannot replace the process consumer's original success or failure. It produces a replayable report containing the standard-input outcome, attempted signals, signal and post-spawn process errors, an available terminal result, whether termination remained unconfirmed, and whether the total deadline expired. When no terminal result arrives by that deadline, local streams are destroyed and the child is unreferenced so host shutdown can continue; the report preserves the residual orphan risk.
