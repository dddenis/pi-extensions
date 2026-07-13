import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { resolveAgentDirectoryEffect } from "../lib/agent-directory";
import { type EnvironmentService } from "../services/environment";
import {
  type FileSystemError,
  FileSystemService,
} from "../services/file-system";
import { type HomeDirectoryService } from "../services/home-directory";
import { type AgentFrontmatter, decodeAgentFrontmatter } from "./schemas";

export interface DiscoveredAgent extends AgentFrontmatter {
  readonly rolePrompt: string;
  readonly writer: boolean;
  readonly definitionPath: string;
}

export interface AgentDefinitionDiagnostic {
  readonly definitionPath: string;
  readonly message: string;
  readonly agentName?: string;
}

export type AgentCatalogState =
  | { readonly _tag: "Complete" }
  | { readonly _tag: "Indeterminate" }
  | { readonly _tag: "Unavailable" };

export interface AgentDiscovery {
  readonly catalog: AgentCatalogState;
  readonly definitions: ReadonlyArray<DiscoveredAgent>;
  readonly diagnostics: ReadonlyArray<AgentDefinitionDiagnostic>;
}

interface ParsedDefinition {
  readonly _tag: "Definition";
  readonly definition: DiscoveredAgent;
}

interface ParsedDiagnostic {
  readonly _tag: "Diagnostic";
  readonly diagnostic: AgentDefinitionDiagnostic;
}

type ParsedFile = ParsedDefinition | ParsedDiagnostic;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const freezeDiagnostic = (
  value: AgentDefinitionDiagnostic,
): AgentDefinitionDiagnostic =>
  Object.freeze({
    definitionPath: value.definitionPath,
    message: value.message,
    ...(value.agentName === undefined ? {} : { agentName: value.agentName }),
  });

const freezeDefinition = (
  frontmatter: AgentFrontmatter,
  rolePrompt: string,
  definitionPath: string,
): DiscoveredAgent =>
  Object.freeze({
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.model === undefined ? {} : { model: frontmatter.model }),
    ...(frontmatter.thinking === undefined
      ? {}
      : { thinking: frontmatter.thinking }),
    ...(frontmatter.tools === undefined
      ? {}
      : { tools: Object.freeze([...frontmatter.tools]) }),
    writer: frontmatter.writer ?? true,
    rolePrompt,
    definitionPath,
  });

const frontmatterAgentName = (
  frontmatter: Record<string, unknown>,
): string | undefined => {
  const name = frontmatter.name;
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const parseDefinition = (
  definitionPath: string,
  content: string,
): ParsedFile => {
  let parsed: {
    readonly frontmatter: Record<string, unknown>;
    readonly body: string;
  };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (error) {
    return {
      _tag: "Diagnostic",
      diagnostic: freezeDiagnostic({
        definitionPath,
        message: errorMessage(error),
      }),
    };
  }

  try {
    const frontmatter = decodeAgentFrontmatter(parsed.frontmatter);
    const rolePrompt = parsed.body.trim();
    if (rolePrompt.length === 0) {
      return {
        _tag: "Diagnostic",
        diagnostic: freezeDiagnostic({
          definitionPath,
          agentName: frontmatter.name,
          message: "Agent definition body must not be empty",
        }),
      };
    }
    return {
      _tag: "Definition",
      definition: freezeDefinition(frontmatter, rolePrompt, definitionPath),
    };
  } catch (error) {
    const agentName = frontmatterAgentName(parsed.frontmatter);
    return {
      _tag: "Diagnostic",
      diagnostic: freezeDiagnostic({
        definitionPath,
        message: errorMessage(error),
        ...(agentName === undefined ? {} : { agentName }),
      }),
    };
  }
};

const fileSystemDiagnostic = (
  definitionPath: string,
  error: FileSystemError,
): AgentDefinitionDiagnostic =>
  freezeDiagnostic({ definitionPath, message: error.message });

const catalogState = (tag: AgentCatalogState["_tag"]): AgentCatalogState =>
  Object.freeze({ _tag: tag });

const emptyDiscovery = (): AgentDiscovery =>
  Object.freeze({
    catalog: catalogState("Complete"),
    definitions: Object.freeze([]),
    diagnostics: Object.freeze([]),
  });

const discoverInDirectory = (
  definitionsDirectory: string,
): Effect.Effect<AgentDiscovery, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const exists = yield* fileSystem.exists(definitionsDirectory).pipe(
      Effect.match({
        onFailure: (error) => fileSystemDiagnostic(definitionsDirectory, error),
        onSuccess: (value) => value,
      }),
    );
    if (exists === false) return emptyDiscovery();
    if (exists !== true) {
      return Object.freeze({
        catalog: catalogState("Unavailable"),
        definitions: Object.freeze([]),
        diagnostics: Object.freeze([exists]),
      });
    }

    const directoryRead = yield* fileSystem
      .readDirectory(definitionsDirectory)
      .pipe(
        Effect.match({
          onFailure: (error) => ({
            _tag: "Failure" as const,
            diagnostic: fileSystemDiagnostic(definitionsDirectory, error),
          }),
          onSuccess: (entries) => ({ _tag: "Success" as const, entries }),
        }),
      );
    if (directoryRead._tag === "Failure") {
      return Object.freeze({
        catalog: catalogState("Unavailable"),
        definitions: Object.freeze([]),
        diagnostics: Object.freeze([directoryRead.diagnostic]),
      });
    }

    const candidates = directoryRead.entries.filter(
      (entry) => entry.kind === "file" && entry.name.endsWith(".md"),
    );
    const parsed = yield* Effect.forEach(candidates, (entry) => {
      const definitionPath = path.join(definitionsDirectory, entry.name);
      return fileSystem.readTextFile(definitionPath).pipe(
        Effect.map((content) => parseDefinition(definitionPath, content)),
        Effect.catchAll((error) =>
          Effect.succeed<ParsedFile>({
            _tag: "Diagnostic",
            diagnostic: fileSystemDiagnostic(definitionPath, error),
          }),
        ),
      );
    });

    const definitions = parsed.flatMap((item) =>
      item._tag === "Definition" ? [item.definition] : [],
    );
    const diagnostics = parsed.flatMap((item) =>
      item._tag === "Diagnostic" ? [item.diagnostic] : [],
    );
    const counts = new Map<string, number>();
    for (const definition of definitions) {
      counts.set(definition.name, (counts.get(definition.name) ?? 0) + 1);
    }

    const uniqueDefinitions = definitions.filter(
      (definition) => counts.get(definition.name) === 1,
    );
    const duplicateDiagnostics = definitions.flatMap((definition) =>
      counts.get(definition.name) === 1
        ? []
        : [
            freezeDiagnostic({
              definitionPath: definition.definitionPath,
              agentName: definition.name,
              message: `Duplicate agent name: ${definition.name}`,
            }),
          ],
    );

    const allDiagnostics = Object.freeze([
      ...diagnostics,
      ...duplicateDiagnostics,
    ]);
    return Object.freeze({
      catalog: catalogState(
        allDiagnostics.some(({ agentName }) => agentName === undefined)
          ? "Indeterminate"
          : "Complete",
      ),
      definitions: Object.freeze(uniqueDefinitions),
      diagnostics: allDiagnostics,
    });
  });

export const discoverAgents: Effect.Effect<
  AgentDiscovery,
  never,
  FileSystemService | EnvironmentService | HomeDirectoryService
> = Effect.gen(function* () {
  const agentDirectory = yield* resolveAgentDirectoryEffect;
  return yield* discoverInDirectory(
    path.join(agentDirectory, "subagents", "agents"),
  );
});
