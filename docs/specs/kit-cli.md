# Kit CLI

## Overview

`kit` is the repository's internal Effect-powered CLI. Invoke it with `bun run kit/main.ts <command>`; the devenv `kit` script uses the same entrypoint.

## Command Surface

The available commands are:

- `kit context sync`
- `kit pi link-global`
- `kit pi unlink-global`

## Context Sync Behavior

`kit context sync` synchronizes the managed read-only context repositories to refs derived from repository dependency versions. [Context Repositories](./context-repos.md) owns the managed sources, pinning rules, and synchronization semantics.

The command must fail clearly when a managed package version cannot be obtained under the context-repository contract, no supported upstream ref exists, or a Git operation fails. Synchronization is manual and must not run during package installation.

## Pi Link Behavior

`kit pi link-global` and `kit pi unlink-global` apply the package-root link contract defined by [Extensions](./extensions.md#global-package-link). Both commands report successful idempotent outcomes and fail without modifying conflicting destinations.

Filesystem failures identify the failing path and preserve the underlying cause. Neither command supports forced replacement or removal.
