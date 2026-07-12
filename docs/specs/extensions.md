# Extensions

## Source and Discovery

A Pi-loadable extension entrypoint lives at `src/<extension-name>/index.ts`. Shared extension runtime modules may live in directories such as `src/lib/` and `src/services/`; their filenames do not affect discovery.

The root `package.json` field `pi.extensions` is the sole discovery authority. It lists every loadable extension by exact source path, so helper modules are never loaded merely because they are named `index.ts`.

## Global Package Link

Pi loads the repository as a local package through `<agent-dir>/extensions/pi-extensions`, a directory symlink to the canonical repository root. Global-link commands must run from the repository root and canonicalize their current working directory as the link target. `<agent-dir>` comes from a non-empty `PI_CODING_AGENT_DIR` and defaults to `~/.pi/agent` when the variable is unset or empty. For Pi-compatible environment expansion, an exact `~` value expands to the home directory, `~/` expands beneath the home directory on every platform, and `~\` does the same on Windows before absolute normalization; other tilde forms are not expanded.

Linking creates the parent extension directory when needed and is idempotent for the correct link. Linking never replaces another symlink, file, or directory. Unlinking is idempotent when absent and removes only a symlink resolving to the current repository root. Conflicts require manual intervention; no force mode exists.

When `<agent-dir>/extensions` has an immutable or declaratively managed parent, users must either declare the same package-root symlink through their configuration or consistently configure Pi and these commands with a writable `PI_CODING_AGENT_DIR`. The commands do not force replacement, automatically choose a fallback directory, or bypass the parent directory's protections.

## Current Extensions

- [Attention hooks](./attention-hooks.md) provides audio notifications for settled runs and subagent attention.
- [Custom footer](./custom-footer.md) provides the interactive TUI footer and OpenAI limit status.
- [History picker](./history-picker.md) provides interactive search across current and saved user messages.

## Runtime Dependencies

Developers install dependencies at the repository root with `bun install`. Pi resolves extension imports through the package-root symlink into the root `node_modules` tree.

Third-party packages imported by extension runtime code belong in `dependencies`. Pi-hosted extension APIs belong in `peerDependencies` with a `*` range and may also appear at a concrete version in `devDependencies` for local typechecking and tools. Direct imports from the Pi-hosted TUI follow this peer-plus-concrete-development-dependency rule. Packages used only by repository tooling remain development dependencies.

## Validation

Extension changes pass `bun run check`, including the [attention-hooks](./attention-hooks.md), [custom-footer](./custom-footer.md), and [history-picker](./history-picker.md) feature contracts. Global linking and unlinking are validated in an isolated agent directory. Global loading is validated by linking the package, confirming the symlink target, reloading Pi, and confirming that the configured extension entrypoints load successfully.
