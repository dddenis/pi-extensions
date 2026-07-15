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
  type SubagentError,
} from "./errors";
import type {
  SubagentRequest,
  SubagentTaskRequest,
  ThinkingLevel,
  ToolInheritance,
} from "./schemas";
import {
  resolveToolInheritance,
  type ParentToolSnapshot,
} from "./tool-inheritance";

interface ResolvedAgentBase {
  readonly name: string;
  readonly description: string;
  readonly rolePrompt: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
}

export type ResolvedAgent =
  | (ResolvedAgentBase & { readonly source: "builtin" })
  | (ResolvedAgentBase & {
      readonly source: "global";
      readonly definitionPath: string;
    });

export interface ResolvedTask {
  readonly index: number;
  readonly task: string;
  readonly cwd: string;
  readonly agent: ResolvedAgent;
  readonly toolInheritance: ToolInheritance;
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

export interface ParentSnapshot extends ParentToolSnapshot {
  readonly model?: string;
  readonly thinking: ThinkingLevel;
}

export interface PreflightInput {
  readonly request: SubagentRequest;
  readonly discovery: AgentDiscovery;
  readonly parent: ParentSnapshot;
  readonly models: ModelResolutionPort;
}

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
  const definition = discovery.definitions.find(
    (candidate) => candidate.name === name,
  );
  if (definition?.source === "builtin") return Effect.succeed(definition);

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
): ResolvedAgent => {
  const base = {
    name: definition.name,
    description: definition.description,
    rolePrompt: definition.rolePrompt,
    model,
    thinking,
  };
  return Object.freeze(
    definition.source === "builtin"
      ? { ...base, source: "builtin" as const }
      : {
          ...base,
          source: "global" as const,
          definitionPath: definition.definitionPath,
        },
  );
};

const resolveTask = (
  task: SubagentTaskRequest,
  index: number,
  input: PreflightInput,
  toolInheritance: ToolInheritance,
): Effect.Effect<ResolvedTask, SubagentError, FileSystemService> =>
  Effect.gen(function* () {
    const definition = yield* findDefinition(task.agent, input.discovery);
    const cwd = yield* resolveWorkingDirectory(task.cwd, input.parent.cwd);
    const resolvedModel = yield* resolveModel(
      definition,
      input.parent,
      input.models,
    );
    return Object.freeze({
      index,
      task: task.task,
      cwd,
      agent: freezeResolvedAgent(
        definition,
        resolvedModel.model,
        resolvedModel.thinking,
      ),
      toolInheritance,
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
    const toolInheritance = yield* resolveToolInheritance(input.parent);
    const resolved = yield* Effect.forEach(input.request.tasks, (task, index) =>
      resolveTask(task, index, input, toolInheritance),
    );
    return Object.freeze(resolved);
  });
