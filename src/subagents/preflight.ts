import path from "node:path";
import { Effect } from "effect";
import { FileSystemService } from "../services/file-system";
import type {
  AgentDefinitionDiagnostic,
  AgentDiscovery,
  DiscoveredAgent,
} from "./agents";
import {
  AgentDefinitionError,
  InvalidSubagentInput,
  InvalidWorkingDirectoryError,
  ToolProviderError,
  UnsafeReaderError,
  WriterPolicyError,
  type SubagentError,
} from "./errors";
import type {
  SubagentRequest,
  SubagentTaskRequest,
  ThinkingLevel,
} from "./schemas";

export const READER_SAFE_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
]);

const RESERVED_TOOLS = new Set(["complete_subagent", "subagent"]);

export interface ResolvedAgent {
  readonly name: string;
  readonly description: string;
  readonly rolePrompt: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly tools?: ReadonlyArray<string>;
  readonly writer: boolean;
  readonly providerExtensions: ReadonlyArray<string>;
  readonly definitionPath: string;
}

export interface ResolvedTask {
  readonly index: number;
  readonly task: string;
  readonly cwd: string;
  readonly agent: ResolvedAgent;
}

export interface ModelResolutionPort {
  readonly resolve: (
    pattern: string,
    thinking: ResolvedAgent["thinking"],
  ) => Effect.Effect<
    { readonly model: string; readonly thinking: ResolvedAgent["thinking"] },
    SubagentError
  >;
}

export interface ParentSnapshot {
  readonly cwd: string;
  readonly model?: string;
  readonly thinking: ThinkingLevel;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    readonly path: string;
    readonly baseDir?: string;
  }>;
}

export interface PreflightInput {
  readonly request: SubagentRequest;
  readonly discovery: AgentDiscovery;
  readonly parent: ParentSnapshot;
  readonly models: ModelResolutionPort;
}

const providerError = (
  toolName: string,
  message: string,
  details: { readonly source?: string; readonly providerPath?: string } = {},
): ToolProviderError =>
  new ToolProviderError({
    toolName,
    message,
    ...(details.source === undefined ? {} : { source: details.source }),
    ...(details.providerPath === undefined
      ? {}
      : { providerPath: details.providerPath }),
  });

const resolveWorkingDirectory = (
  requestedCwd: string | undefined,
  parentCwd: string,
): Effect.Effect<string, InvalidWorkingDirectoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const cwd = path.resolve(parentCwd, requestedCwd ?? parentCwd);
    const metadata = yield* fileSystem.stat(cwd).pipe(
      Effect.mapError(
        (error) =>
          new InvalidWorkingDirectoryError({
            cwd,
            message: error.message,
          }),
      ),
    );
    if (metadata.kind !== "directory") {
      return yield* new InvalidWorkingDirectoryError({
        cwd,
        message: "Working directory must be an existing directory",
      });
    }
    return cwd;
  });

const copyDiagnostics = (
  diagnostics: ReadonlyArray<AgentDefinitionDiagnostic>,
): ReadonlyArray<AgentDefinitionDiagnostic> =>
  Object.freeze(
    diagnostics.map((diagnostic) =>
      Object.freeze({
        definitionPath: diagnostic.definitionPath,
        message: diagnostic.message,
        ...(diagnostic.agentName === undefined
          ? {}
          : { agentName: diagnostic.agentName }),
      }),
    ),
  );

const definitionFailure = (
  name: string,
  reason: AgentDefinitionError["reason"],
  diagnostics: ReadonlyArray<AgentDefinitionDiagnostic>,
  message: string,
): AgentDefinitionError => {
  const copied = copyDiagnostics(diagnostics);
  const definitionPaths = Object.freeze(
    copied.map(({ definitionPath }) => definitionPath),
  );
  return new AgentDefinitionError({
    definitionPath: definitionPaths[0] ?? name,
    definitionPaths,
    diagnostics: copied,
    reason,
    agentName: name,
    message,
  });
};

const diagnosticSummary = (
  diagnostics: ReadonlyArray<AgentDefinitionDiagnostic>,
): string =>
  diagnostics
    .map(({ definitionPath, message }) => `${definitionPath}: ${message}`)
    .join("; ");

const findDefinition = (
  name: string,
  discovery: AgentDiscovery,
): Effect.Effect<
  DiscoveredAgent,
  InvalidSubagentInput | AgentDefinitionError
> => {
  const namedDiagnostics = discovery.diagnostics.filter(
    (candidate) => candidate.agentName === name,
  );
  if (namedDiagnostics.length > 0) {
    return Effect.fail(
      definitionFailure(
        name,
        "invalid-definition",
        namedDiagnostics,
        `Requested agent has invalid or duplicate definitions: ${diagnosticSummary(namedDiagnostics)}`,
      ),
    );
  }

  const definition = discovery.definitions.find(
    (candidate) => candidate.name === name,
  );
  if (definition !== undefined) return Effect.succeed(definition);

  if (discovery.catalog._tag === "Unavailable") {
    return Effect.fail(
      definitionFailure(
        name,
        "unavailable",
        discovery.diagnostics,
        `Agent definitions directory is unavailable: ${diagnosticSummary(discovery.diagnostics)}`,
      ),
    );
  }
  if (discovery.catalog._tag === "Indeterminate") {
    const namelessDiagnostics = discovery.diagnostics.filter(
      ({ agentName }) => agentName === undefined,
    );
    return Effect.fail(
      definitionFailure(
        name,
        "indeterminate",
        namelessDiagnostics,
        `Agent lookup is indeterminate because definitions could not be identified: ${diagnosticSummary(namelessDiagnostics)}`,
      ),
    );
  }
  return Effect.fail(
    new InvalidSubagentInput({
      subject: name,
      field: "agent",
      message: "No discovered agent has this name",
    }),
  );
};

const validateReader = (
  definition: DiscoveredAgent,
): Effect.Effect<void, UnsafeReaderError> => {
  const readerSafe =
    definition.writer === false &&
    definition.tools !== undefined &&
    definition.tools.length > 0 &&
    definition.tools.every((name) => READER_SAFE_TOOLS.has(name));

  return definition.writer === false && !readerSafe
    ? Effect.fail(
        new UnsafeReaderError({
          agentName: definition.name,
          message:
            "Reader agents require a nonempty allowlist containing only reader-safe tools",
          ...(definition.tools === undefined
            ? {}
            : { tools: Object.freeze([...definition.tools]) }),
        }),
      )
    : Effect.void;
};

const resolveProviderExtensions = (
  definition: DiscoveredAgent,
  parent: ParentSnapshot,
): Effect.Effect<ReadonlyArray<string>, ToolProviderError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const canonicalPaths: Array<string> = [];
    const seen = new Set<string>();

    for (const toolName of definition.tools ?? []) {
      if (RESERVED_TOOLS.has(toolName)) {
        return yield* providerError(
          toolName,
          "Subagents may not declare reserved orchestration tools",
        );
      }

      const providers = parent.tools.filter((tool) => tool.name === toolName);
      if (providers.length !== 1) {
        return yield* providerError(
          toolName,
          providers.length === 0
            ? "Tool provider provenance is missing"
            : "Tool provider provenance is ambiguous",
        );
      }

      const provider = providers[0];
      if (provider === undefined) {
        return yield* providerError(
          toolName,
          "Tool provider provenance is missing",
        );
      }
      if (provider.source === "builtin") continue;
      if (provider.source === "sdk") {
        return yield* providerError(
          toolName,
          "SDK tools cannot be loaded by a child",
          {
            source: provider.source,
            providerPath: provider.path,
          },
        );
      }
      if (/^<.*>$/.test(provider.path)) {
        return yield* providerError(
          toolName,
          "Synthetic tool provider paths cannot be loaded by a child",
          { source: provider.source, providerPath: provider.path },
        );
      }

      const providerPath = path.resolve(
        provider.baseDir ?? parent.cwd,
        provider.path,
      );
      const metadata = yield* fileSystem.stat(providerPath).pipe(
        Effect.mapError((error) =>
          providerError(toolName, error.message, {
            source: provider.source,
            providerPath,
          }),
        ),
      );
      if (metadata.kind !== "file") {
        return yield* providerError(
          toolName,
          "External tool provider must be an existing regular file",
          { source: provider.source, providerPath },
        );
      }

      const canonicalPath = yield* fileSystem.realPath(providerPath).pipe(
        Effect.mapError((error) =>
          providerError(toolName, error.message, {
            source: provider.source,
            providerPath,
          }),
        ),
      );
      if (!seen.has(canonicalPath)) {
        seen.add(canonicalPath);
        canonicalPaths.push(canonicalPath);
      }
    }

    return Object.freeze(canonicalPaths);
  });

const resolveModel = (
  definition: DiscoveredAgent,
  parent: ParentSnapshot,
  models: ModelResolutionPort,
): Effect.Effect<
  { readonly model: string; readonly thinking: ThinkingLevel },
  SubagentError
> => {
  const thinking = definition.thinking ?? parent.thinking;
  const model = definition.model ?? parent.model;
  if (model === undefined) {
    return Effect.fail(
      new InvalidSubagentInput({
        subject: definition.name,
        field: "model",
        message: "Parent model is required when the agent omits a model",
      }),
    );
  }
  return models.resolve(model, thinking).pipe(
    Effect.map((resolved) =>
      Object.freeze({
        model: resolved.model,
        thinking: resolved.thinking,
      }),
    ),
  );
};

const freezeResolvedAgent = (
  definition: DiscoveredAgent,
  model: string,
  thinking: ThinkingLevel,
  providerExtensions: ReadonlyArray<string>,
): ResolvedAgent =>
  Object.freeze({
    name: definition.name,
    description: definition.description,
    rolePrompt: definition.rolePrompt,
    model,
    thinking,
    ...(definition.tools === undefined
      ? {}
      : { tools: Object.freeze([...definition.tools]) }),
    writer: definition.writer,
    providerExtensions: Object.freeze([...providerExtensions]),
    definitionPath: definition.definitionPath,
  });

const resolveTask = (
  task: SubagentTaskRequest,
  index: number,
  input: PreflightInput,
): Effect.Effect<ResolvedTask, SubagentError, FileSystemService> =>
  Effect.gen(function* () {
    const definition = yield* findDefinition(task.agent, input.discovery);
    yield* validateReader(definition);
    const cwd = yield* resolveWorkingDirectory(task.cwd, input.parent.cwd);
    const resolvedModel = yield* resolveModel(
      definition,
      input.parent,
      input.models,
    );
    const providerExtensions = yield* resolveProviderExtensions(
      definition,
      input.parent,
    );
    return Object.freeze({
      index,
      task: task.task,
      cwd,
      agent: freezeResolvedAgent(
        definition,
        resolvedModel.model,
        resolvedModel.thinking,
        providerExtensions,
      ),
    });
  });

export const preflight = (
  input: PreflightInput,
): Effect.Effect<
  ReadonlyArray<ResolvedTask>,
  SubagentError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.forEach(input.request.tasks, (task, index) =>
      resolveTask(task, index, input),
    );
    const writers = resolved.filter(({ agent }) => agent.writer);
    if (writers.length > 1) {
      return yield* new WriterPolicyError({
        message: "A subagent batch may contain at most one writer",
        writerCount: writers.length,
        agents: Object.freeze(writers.map(({ agent }) => agent.name)),
      });
    }
    return Object.freeze(resolved);
  });
