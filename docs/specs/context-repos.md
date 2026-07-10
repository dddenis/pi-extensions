# Context Repositories

## Purpose

`.context` contains read-only upstream source material for developers and coding agents working with Effect and Pi. Keeping these sources aligned with package dependencies provides a local, version-matched reference for library behavior.

## Managed Repositories

- `.context/effect` comes from `https://github.com/Effect-TS/effect.git` and tracks `effect@<effect-version>`.
- `.context/pi` comes from `https://github.com/earendil-works/pi.git` and uses the first supported Pi package ref matching the `package.json`-declared coding-agent version.

## Pinning and Synchronization

Managed versions come from `dependencies` or `devDependencies` in `package.json`; one leading `^` or `~` range marker is removed before resolving upstream refs. Sources are added or refreshed as squashed Git subtrees so the checked-in context remains pinned to repository dependencies.

A managed path containing its own `.git` directory is treated as a legacy clone. Synchronization removes that path and replaces it with the pinned squashed subtree so every managed source follows the same checked-in model.

Use `kit context sync` to perform synchronization. [Kit CLI](./kit-cli.md) owns invocation and command-level failure behavior.

## Usage Rules

- Do not edit `.context` by hand.
- Do not import production code from `.context`.
- Prefer matching local `.context` source over guesses or unrelated upstream versions when investigating Effect or Pi behavior.
