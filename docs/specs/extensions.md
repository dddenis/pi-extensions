# Extensions

## Source and Discovery

A Pi-loadable extension entrypoint lives at `src/<extension-name>/index.ts`. Shared extension runtime modules may live in directories such as `src/lib/` and `src/services/`; their filenames do not affect discovery.

The root `package.json` field `pi.extensions` is the sole discovery authority. It lists every loadable extension by exact source path, so helper modules are never loaded merely because they are named `index.ts`.

## Global Package Link

Pi loads the repository as a local package through `<agent-dir>/extensions/pi-extensions`, a directory symlink to the canonical repository root. Global-link commands must run from the repository root and canonicalize their current working directory as the link target. `<agent-dir>` comes from a non-empty `PI_CODING_AGENT_DIR` and defaults to `~/.pi/agent` when the variable is unset or empty. For Pi-compatible environment expansion, an exact `~` value expands to the home directory, `~/` expands beneath the home directory on every platform, and `~\` does the same on Windows before absolute normalization; other tilde forms are not expanded.

Linking creates the parent extension directory when needed and is idempotent for the correct link. Linking never replaces another symlink, file, or directory. Unlinking is idempotent when absent and removes only a symlink resolving to the current repository root. Conflicts require manual intervention; no force mode exists.

When `<agent-dir>/extensions` has an immutable or declaratively managed parent, users must either declare the same package-root symlink through their configuration or consistently configure Pi and these commands with a writable `PI_CODING_AGENT_DIR`. The commands do not force replacement, automatically choose a fallback directory, or bypass the parent directory's protections.

## Current Extensions

`src/smoke/index.ts` registers `/pi-extensions-smoke` and is declared explicitly in `pi.extensions` so developers can verify that Pi loaded the package.

## Runtime Dependencies

Developers install dependencies at the repository root with `bun install`. Pi resolves extension imports through the package-root symlink into the root `node_modules` tree.

Third-party packages imported by extension runtime code belong in `dependencies`. Pi-hosted extension APIs belong in `peerDependencies` with a `*` range and may also appear at a concrete version in `devDependencies` for local typechecking and tools. Packages used only by repository tooling remain development dependencies.

## Validation

Extension changes pass `bun run check`. Global loading is validated by linking the package, confirming the symlink target, reloading Pi, and invoking `/pi-extensions-smoke`.
