# Custom Footer

## Purpose and Scope

The custom footer replaces Pi's built-in footer with session usage, context capacity, model state, extension status, and Codex OpenAI rate-limit information. It is installed only in interactive TUI mode. RPC, JSON, and print modes never install the footer or start its background refresh work.

[Extensions](./extensions.md) owns general extension discovery and runtime dependency declarations. [Process Service](./process-service.md) owns generic child-process semantics and bounded termination.

## Display

The footer shows:

- the working directory, contracting the home directory itself or a true descendant to `~`, followed by an available Git branch and session name;
- cumulative input, output, cache-read, cache-write, and cost across assistant messages, tool results, compaction summaries, and branch summaries, with latest-request cache-hit percentage derived only from assistant messages;
- `(sub)` beside cost when the current model uses OAuth subscription credentials or the subscription-backed Kimi Coding provider;
- remaining context as a percentage and context-window size, with the automatic-compaction indicator only when enabled state is explicitly known;
- the current model and, for reasoning models, the selected thinking level including `thinking off`;
- the provider when more than one provider is available and the terminal has room;
- the most recently successful OpenAI limit status inline, without its redundant OpenAI prefix; and
- non-empty extension statuses on one line, ordered by extension key.

Unknown remaining context is displayed as `?`. Remaining context at or below 30% is a warning and at or below 10% is an error. Until a first rate-limit refresh succeeds, the footer shows no loading or unavailable placeholder. Display fields that can contain external text are kept to one line; carriage returns, line feeds, and tabs become spaces, repeated spaces collapse, and empty statuses are omitted.

Token counts use compact integer, `k`, or `M` forms appropriate to their scale. Monetary totals use three decimal places, and cache-hit and context percentages use one decimal place. Pi does not expose automatic-compaction state through its public extension boundary, so the native adapter conservatively omits the `auto` indicator.

## Terminal Cells and Styling

Every rendered line is bounded by the terminal width in visible cells, including zero-width and narrow terminals and text containing ANSI styles, wide characters, emoji, or combining marks. Context warning/error styling applies only to that segment. Adjacent content explicitly resumes dim styling so truncation or a style reset cannot leak warning/error color.

## Codex Rate Limits

The reader resolves the Codex binary from a non-empty `CODEX_BIN`, then known Bun and Nix user locations, and finally the executable name on `PATH`. It starts `codex app-server --stdio` in the home directory with a copied environment.

The client performs a correlated JSON-RPC initialize handshake before requesting `account/rateLimits/read`. Malformed or unrelated output is ignored unless it is correlated to an active request; correlated protocol errors, invalid results, unavailable windows, early exit, process failures, and the 20-second response timeout are reported through typed failures. Exact Codex limits are preferred, then the first Codex-prefixed limit, then the top-level limit. Five-hour and weekly windows display remaining percentage and an available compact reset time.

## Refresh Policy

A TUI session start installs one footer and starts one controller. The controller owns both a startup-caused initial refresh and a five-minute interval. Turn completion requests a turn-end refresh. Concurrent eligible requests share one actual in-flight result. Interval and turn-end requests observe a 30-second success throttle and failure backoff; startup and manual requests bypass those routine deadlines. Ineligible routine requests are skipped without becoming in flight.

Failures retain a successful cached status as stale and use jittered exponential automatic backoff with a multiplier in `[1, 1.25)`, beginning at one minute and capped at 15 minutes. A first failure without cached data remains visually silent. After a sleep/wake gap greater than six minutes, cached data becomes stale immediately and one wake refresh is delayed by 45 seconds; exactly six minutes is not treated as wake. A delayed wake refresh bypasses success throttling and failure backoff. It joins an actual in-flight refresh but is not suppressed by a refresh that completed earlier during its delay. Manual refresh bypasses automatic gap and backoff policy.

`/custom-footer` requests a manual refresh in TUI mode and reports success as information or failure as an error. Outside TUI mode it starts no Codex process and, when feedback is available, warns that interactive TUI mode is required.

## Lifecycle and Cleanup

Replacing a TUI session removes the previous branch listener and render target by identity before starting replacement ownership. Shutdown restores Pi's default footer, interrupts interval, delayed-wake, in-flight refresh, and process work, then disposes the managed Effect runtime. Repeated start, component disposal, and shutdown are safe.

Codex protocol work is scoped and stops before its managed process shuts down. Cleanup requests standard-input completion for at most 100 milliseconds, requests `SIGTERM` and waits up to one second, then requests `SIGKILL` and waits up to one additional second. One 2.1-second total deadline bounds the complete sequence. Cleanup outcomes never replace the rate-limit result. Generic standard-input, terminal-result, signal escalation, deadline, and residual-orphan guarantees are defined by [Process Service](./process-service.md).
