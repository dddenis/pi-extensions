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

Successful private-file replacement and removal mutate copied file state. Configured failures are recorded but do not mutate that state. Snapshots copy their maps and per-file records so callers cannot mutate internal state. `resetCalls` preserves files, while `reset` restores a copied initial state.
