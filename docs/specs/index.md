# pi-extensions Specs

This directory contains checked-in contracts for the `pi-extensions` repository. Read this file first, then read the spec that owns every module you will touch.

## Spec Map

- [Architecture](./architecture.md) — repository boundaries, TypeScript scopes, test layout, package scripts, and internal CLI organization.
- [Extensions](./extensions.md) — extension source shape, manifest discovery, runtime dependencies, global linking, and validation.
- [Kit CLI](./kit-cli.md) — internal `kit` command surface and command-level behavior.
- [Context Repositories](./context-repos.md) — managed `.context` sources, dependency pinning, and synchronization semantics.
- [File System Service](./file-system-service.md) — typed metadata, text, private creation, atomic publication, canonicalization, and removal operations.
- [Process Service](./process-service.md) — typed child-process boundary, launch acknowledgement, output streams, terminal ownership, and bounded cleanup.
- [Custom Footer](./custom-footer.md) — TUI footer content, OpenAI limit refresh, stale/backoff behavior, and scoped process lifecycle.
- [Test Services](./test-services.md) — reusable Effect test-service contracts.
- [Attention Hooks](./attention-hooks.md) — settled-run and subagent-attention audio notifications, suppression, path resolution, and lifecycle cleanup.
- [History Picker](./history-picker.md) — Ctrl+R interaction, saved-session indexing/cache semantics, fuzzy search, scrolling, and lifecycle cleanup.
- [Subagents](./subagents.md) — one-to-three-child execution, global agent policy, structured completion, private artifacts, rollback, cancellation, and bounded progress.

## Change Rules

Update the owning specification in the same change whenever a documented contract changes. Keep requirements at the level of what and why, and link to the authoritative specification instead of repeating a cross-domain contract.
