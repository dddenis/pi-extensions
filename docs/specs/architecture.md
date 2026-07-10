# Architecture

## Overview

`pi-extensions` is a single-root Bun package for developing Pi extensions. Pi extension entrypoints and shared source live under `src/`, reusable test support lives under `test/`, and repository operations live under `kit/`.

[Extensions](./extensions.md) owns extension source, discovery, dependency, and global-link contracts.

## TypeScript Scopes

- `tsconfig.base.json` owns strict shared compiler options and the Effect language-service plugin.
- `tsconfig.src.json` typechecks production source under `src/`.
- `tsconfig.test.json` typechecks tests under `src/`, `kit/`, and `test/`, together with reusable support under `test/`.
- `kit/tsconfig.json` typechecks the internal CLI without test files.

These explicit scopes keep generated and read-only context sources outside repository typechecking.

## Kit Layout

`kit/main.ts` is the CLI composition root. Each unrelated top-level command owns a vertical slice under `kit/commands/<command>/`, where its CLI surface, implementation, private infrastructure, and tests remain colocated. Infrastructure moves to a shared location only when multiple commands require it.

[Kit CLI](./kit-cli.md) owns the command surface and command-level behavior.

## Test Layout

Tests are colocated with the implementation or configuration they primarily verify and append `.test.ts` to the owner's basename. Suites that cover independent owners are split by owner.

Vitest and the test TypeScript project cover tests under `src/`, `kit/`, and `test/`. Repository-wide globs are avoided so `.context` remains outside test discovery and typechecking.

## Package Scripts

- `bun fmt` formats the repository with Prettier.
- `bun lint` runs ESLint.
- `bun typecheck` checks the source, test, and kit TypeScript projects with `tsc`.
- `bun run test` runs Vitest through Bun.
- `bun run check` runs typechecking, linting, and tests.
- `bun run pi:link-global` links the repository package root into Pi's global extension directory.
- `bun run pi:unlink-global` removes that link when the current repository owns it.
