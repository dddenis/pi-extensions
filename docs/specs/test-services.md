# Test Services

## Purpose

Reusable Effect test doubles live under `test/services/`. They let tests configure production-facing behavior and inspect recorded interactions without exposing mutable internal state.

## Dual-Tag Contract

A stateful fake provides the production service tag consumed by application code and a test-only control tag consumed by tests. One layer provides both tags, and both services share the same Effect-owned state.

## Control Contract

- Control operations return `Effect` values.
- Shared state is Effect-owned and encapsulated by the test layer.
- `getState` returns snapshots of recorded calls and configuration.
- Snapshots copy arrays and objects so consumers cannot mutate internal state.
- Stateful fakes expose `getState`, `resetCalls`, and `reset` controls.
- Production-facing methods die on unimplemented or unconfigured test behavior.
- Explicit application failures use the same error contract as the production service.

## File System Fake

The file system fake can configure existence, modification times, directory entries, metadata, canonical paths, text contents, and failures by operation and path. Controls can replace any of those configured values or failures during a test.

Successful directory creation, write, append, rename, and removal update the fake's related existence, metadata, canonical-path, content, and parent-listing views coherently. Path topology follows the host platform by default; tests may explicitly select POSIX or Windows semantics for deterministic foreign-platform coverage. Rename moves the represented path, removal requires an explicit recursive request for directories, and configured mutation failures are recorded without applying the mutation. Every operation is recorded before returning a configured result, typed failure, or unconfigured-behavior defect.

Configuration, returned metadata and entries, failures, call history, maps, and reset baselines are copied. `resetCalls` preserves the current fake filesystem while clearing observations; `reset` restores a copy of the initial configuration.

## Process Fake

The process fake models multiple concurrent children by stable spawn index. Tests can opt into manual launch acknowledgement and can emit launch success, replayable launch failure, stdout lines, stdout stream failures, stderr chunks, output EOF, pre-spawn errors, post-launch process errors, and terminal exits for a selected child. Direct exit and output EOF are independent, while a convenience completion control emits both. A post-launch error is retained in the shutdown report without replacing later streams or exit. An invalid index is unconfigured test behavior.

Snapshots expose copied aggregate and per-child command, arguments, options, standard-input activity, signals, lifecycle events, local-output close counts, and unref counts. The fake retains the production service's replayable launch and terminal observations, indexed stream ownership, scoped cleanup policy, and detached-child interruption behavior. `resetCalls` clears observations while retaining spawned controls; `reset` restores an empty process fake.
