# History Picker

## Interaction and Modes

The history picker exposes `Ctrl+R` with the description **Search previous user messages**. In interactive TUI mode it opens an overlay, prefills search from the current editor, and replaces the editor with the exact selected message. Cancellation leaves the editor unchanged.

The overlay uses a 100-column target width, a 50-column minimum, an 80% maximum height, and a two-cell margin. The overlay uses a complete accent-colored box border with rounded corners and one blank column of horizontal padding whenever its effective row budget is at least four rows and its normalized render width is at least five columns. The frame consumes two rows and four horizontal columns, including both padding columns; below either threshold it falls back to borderless rendering so search and one result or the no-results placeholder remain usable.

The picker reads current terminal height on every render and keeps its output within the overlay's effective percentage-and-margin row budget. Terminal resize changes the visible result capacity without reopening the overlay or resetting query, scope, selection, or saved-snapshot state; Pi's matching maximum height remains a defensive bound.

RPC does not list history or open the overlay and warns `History picker requires interactive TUI mode.` when UI feedback is available. JSON and print modes exit silently. Unexpected overlay failures produce an error notification.

## Picker Behavior

The picker starts in all-project scope. `Ctrl+P` is a fixed scope toggle between all projects and the exact current working directory; toggling resets selection. Search input otherwise uses Pi's single-line `Input` behavior.

Cancel, confirm, selection-up, and selection-down honor the injected `tui.select.*` bindings. The picker container propagates focus to its nested input so Pi can place the hardware cursor for IME candidate windows. Query, scope, result, focus, and selection changes request a render.

Up to 12 results are visible when height permits. The moving result window uses the current responsive capacity and keeps the selected row visible, including rows after index 11. Search and one selected result, or search and the no-results placeholder, are retained whenever at least two interior content rows are available after the responsive border decision. If mandatory rows do not fit with all applicable chrome, rows disappear in order: help, loading status, scope, title, then warning; result capacity contracts before chrome is removed merely to preserve all 12 results. Each result row is a query-centered, single-line, control-safe projection bounded by the width supplied by the TUI. Empty-query previews start at the beginning, and omitted context is visibly marked.

## History Sources

Each invocation projects user messages afresh from all current-session entries, including entries on inactive branches. String content is indexed directly; mixed content concatenates text blocks and ignores images. The current projection is combined with the shared saved-session snapshot.

Saved history comes from Pi's public all-session listing. Each listed JSONL file is decoded by physical line. Supported session and message shapes are validated, irrelevant entry types are ignored, and user text is projected with the session header working directory when present. A malformed supported line fails that file with its physical line number, including blank lines in the count.

## Cache and Refresh

Saved-session indexing is shared across picker invocations. Concurrent refresh callers join a single flight, while listeners receive loading and completed snapshots. Unchanged files reuse cached projections by modification time; changed files are reread. A successful listing evicts paths no longer present, including a successful empty listing.

In Pi 0.80.6, public `SessionManager.listAll()` can convert some host listing failures to `[]`. The live adapter has no failure discriminator and must treat that return as a successful empty listing, so such host failures can evict the cache. Only typed `SessionListingService` failures preserve the previous cache and report saved sessions as unavailable.

Stat, read, or schema failure retains a prior valid projection for that path, omits an invalid new path, and reports the number of unreadable saved sessions. These warnings remain visible alongside usable current and cached results.

## Search Ordering

The picker prepares a normalized corpus from the combined current and saved items and rebuilds it only when that combined snapshot changes. Exact raw projected `HistoryItem.text` remains authoritative for case-sensitive deduplication, selection and confirmation, cached projections, direct search, and normalized-to-raw source mapping. Scope filtering happens before deduplication, current-project scope compares working directories exactly, and only the newest timestamp remains for duplicate text.

An empty query orders results by newest timestamp and then lexical raw text. A non-empty query ranks direct exact matches, word-boundary substrings, other substrings, and then segmented smart-fuzzy matches. Matching is case- and diacritic-insensitive, while match evidence maps back to ranges in the raw source text. Fuzzy quality breaks fuzzy-tier ties; remaining ties use newest timestamp and then lexical raw text so ordering stays deterministic.

Normalized fuzzy targets are segmented toward 512 UTF-16 code units, preferring line boundaries, then sentence boundaries, then whitespace boundaries within the final 64 units before each cap. Every target cut overlaps by 256 normalized units, and accepted fuzzy evidence is limited to a 256-unit normalized span so local fuzzy matches do not depend on segment alignment. Queries longer than 256 normalized units use direct matching only. At most 200 results are retained, and the picker displays `200+` when additional distinct messages matched.

## Lifecycle

Preparation and search run asynchronously in cooperative batches of at most 64 records or segments. Preparation also bounds work within an individual record and yields to host input and rendering between chunks, so an oversized message does not prevent cancellation. A newer query, scope, or combined-item generation interrupts obsolete work, and generation checks reject any obsolete completion that races with interruption. Replacement preparation never publishes a partial corpus; the latest query reruns only after the complete replacement corpus is installed. Prior results remain visible during work; `Searching…` appears only after 50ms, and only the latest completed result snapshot replaces the visible set atomically.

If fuzzy matching becomes unavailable, direct matches remain usable and an inline warning reports the degradation. An unexpected preparation or search failure retains the prior usable snapshot and reports an inline search warning instead of clearing results.

Each overlay owns its saved-snapshot subscription and asynchronous search lifecycle. Selection, cancellation, or overlay failure closes those resources and interrupts pending preparation, search, and delayed status work, while the indexer's shared refresh continues so later picker invocations can join it and reuse its cache.

Session shutdown is idempotent: it shuts down the shared indexer and every active or starting overlay search lifecycle, awaiting their interrupted work and closed listeners before disposing the Effect runtime.
