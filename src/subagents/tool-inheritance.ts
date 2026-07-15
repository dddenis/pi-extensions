import path from "node:path";
import { Effect, Either } from "effect";
import { FileSystemService } from "../services/file-system";
import { isToolNameTransportSafe, type ToolInheritance } from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";

const RESERVED_PARENT_TOOL_NAMES = new Set(["subagent", "complete_subagent"]);
const CHILD_COMPLETION_TOOL_NAME = "complete_subagent";

export interface ParentToolProvider {
  readonly name: string;
  readonly source: string;
  readonly path: string;
  readonly baseDir?: string;
}

export interface ParentToolSnapshot {
  readonly cwd: string;
  readonly activeToolNames: ReadonlyArray<string>;
  readonly toolProviders: ReadonlyArray<ParentToolProvider>;
}

const diagnostic = (
  toolName: string,
  message: string,
  provider?: ParentToolProvider,
  providerPath?: string,
): string =>
  sanitizeTerminalText(
    `Inherited tool "${toolName}" omitted: ${message}${
      provider === undefined ? "" : `; source=${provider.source}`
    }${providerPath === undefined ? "" : `; provider=${providerPath}`}`,
  )
    .replace(/\s+/gu, " ")
    .trim();

const freeze = (
  parentActiveToolNames: ReadonlyArray<string>,
  effectiveToolNames: ReadonlyArray<string>,
  providerExtensions: ReadonlyArray<string>,
  diagnostics: ReadonlyArray<string>,
): ToolInheritance =>
  Object.freeze({
    parentActiveToolNames: Object.freeze([...parentActiveToolNames]),
    effectiveToolNames: Object.freeze([...effectiveToolNames]),
    providerExtensions: Object.freeze([...providerExtensions]),
    diagnostics: Object.freeze([...diagnostics]),
  });

export const resolveToolInheritance = (
  parent: ParentToolSnapshot,
): Effect.Effect<ToolInheritance, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const effectiveToolNames: Array<string> = [];
    const providerExtensions: Array<string> = [];
    const diagnostics: Array<string> = [];
    const seenToolNames = new Set<string>();
    const seenProviders = new Set<string>();

    for (const toolName of parent.activeToolNames) {
      if (seenToolNames.has(toolName)) continue;
      seenToolNames.add(toolName);
      if (!isToolNameTransportSafe(toolName)) {
        diagnostics.push(
          diagnostic(
            toolName,
            "cannot be represented by Pi --tools as one unchanged non-empty item",
          ),
        );
        continue;
      }
      if (RESERVED_PARENT_TOOL_NAMES.has(toolName)) continue;

      const providers = parent.toolProviders.filter(
        ({ name }) => name === toolName,
      );
      if (providers.length !== 1) {
        diagnostics.push(
          diagnostic(
            toolName,
            providers.length === 0
              ? "provider metadata is missing"
              : "provider metadata is ambiguous",
          ),
        );
        continue;
      }

      const provider = providers[0];
      if (provider === undefined) {
        diagnostics.push(diagnostic(toolName, "provider metadata is missing"));
        continue;
      }
      if (provider.source === "builtin") {
        effectiveToolNames.push(toolName);
        continue;
      }
      if (provider.source === "sdk") {
        diagnostics.push(
          diagnostic(
            toolName,
            "SDK tools cannot be recreated in a child process",
            provider,
          ),
        );
        continue;
      }
      if (/^<.*>$/u.test(provider.path)) {
        diagnostics.push(
          diagnostic(
            toolName,
            "synthetic provider paths are not reloadable",
            provider,
          ),
        );
        continue;
      }

      const providerPath = path.resolve(
        provider.baseDir ?? parent.cwd,
        provider.path,
      );
      const metadata = yield* Effect.either(fileSystem.stat(providerPath));
      if (Either.isLeft(metadata)) {
        diagnostics.push(
          diagnostic(toolName, metadata.left.message, provider, providerPath),
        );
        continue;
      }
      if (metadata.right.kind !== "file") {
        diagnostics.push(
          diagnostic(
            toolName,
            "provider must be an existing regular file",
            provider,
            providerPath,
          ),
        );
        continue;
      }

      const canonical = yield* Effect.either(fileSystem.realPath(providerPath));
      if (Either.isLeft(canonical)) {
        diagnostics.push(
          diagnostic(toolName, canonical.left.message, provider, providerPath),
        );
        continue;
      }

      effectiveToolNames.push(toolName);
      if (!seenProviders.has(canonical.right)) {
        seenProviders.add(canonical.right);
        providerExtensions.push(canonical.right);
      }
    }

    effectiveToolNames.push(CHILD_COMPLETION_TOOL_NAME);
    return freeze(
      parent.activeToolNames,
      effectiveToolNames,
      providerExtensions,
      diagnostics,
    );
  });
