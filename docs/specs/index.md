# pi-extensions Specs

This directory contains checked-in contracts for the `pi-extensions` repository. Read this file first, then read the spec that owns every module you will touch.

## Spec Map

- [Architecture](./architecture.md) — repository boundaries, TypeScript scopes, test layout, package scripts, and internal CLI organization.
- [Extensions](./extensions.md) — extension source shape, manifest discovery, runtime dependencies, global linking, and validation.
- [Kit CLI](./kit-cli.md) — internal `kit` command surface and command-level behavior.
- [Context Repositories](./context-repos.md) — managed `.context` sources, dependency pinning, and synchronization semantics.
- [Test Services](./test-services.md) — reusable Effect test-service contracts.

## Change Rules

Update the owning specification in the same change whenever a documented contract changes. Keep requirements at the level of what and why, and link to the authoritative specification instead of repeating a cross-domain contract.
