import { Data } from "effect";
import type { AgentDefinitionDiagnostic } from "./agents";

export class InvalidSubagentInput extends Data.TaggedError(
  "InvalidSubagentInput",
)<{
  readonly subject: string;
  readonly message: string;
  readonly field?: string;
}> {}

export class AgentDefinitionError extends Data.TaggedError(
  "AgentDefinitionError",
)<{
  readonly definitionPath: string;
  readonly definitionPaths: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<AgentDefinitionDiagnostic>;
  readonly reason: "invalid-definition" | "indeterminate" | "unavailable";
  readonly message: string;
  readonly agentName?: string;
}> {}

export class InvalidWorkingDirectoryError extends Data.TaggedError(
  "InvalidWorkingDirectoryError",
)<{
  readonly cwd: string;
  readonly message: string;
}> {}

export class RunStoreError extends Data.TaggedError("RunStoreError")<{
  readonly operation: string;
  readonly path: string;
  readonly message: string;
  readonly runId?: string;
}> {}

export class ChildProcessError extends Data.TaggedError("ChildProcessError")<{
  readonly operation: string;
  readonly message: string;
  readonly runId?: string;
  readonly agent?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}> {}

export class PiEventStreamError extends Data.TaggedError("PiEventStreamError")<{
  readonly message: string;
  readonly runId?: string;
  readonly lineNumber?: number;
  readonly rawLine?: string;
}> {}

export class CompletionValidationError extends Data.TaggedError(
  "CompletionValidationError",
)<{
  readonly message: string;
  readonly status?: string;
  readonly reportPath?: string;
  readonly summary?: string;
}> {}

export type SubagentError =
  | InvalidSubagentInput
  | AgentDefinitionError
  | InvalidWorkingDirectoryError
  | RunStoreError
  | ChildProcessError
  | PiEventStreamError
  | CompletionValidationError;

const primarySubject = (error: SubagentError): string | undefined => {
  switch (error._tag) {
    case "InvalidSubagentInput":
      return error.subject;
    case "AgentDefinitionError":
      return error.agentName ?? error.definitionPath;
    case "InvalidWorkingDirectoryError":
      return error.cwd;
    case "RunStoreError":
      return error.runId ?? error.path;
    case "ChildProcessError":
      return error.runId ?? error.agent ?? error.operation;
    case "PiEventStreamError":
      return (
        error.runId ??
        (error.lineNumber === undefined
          ? undefined
          : `line ${error.lineNumber}`)
      );
    case "CompletionValidationError":
      return error.status ?? error.reportPath ?? error.summary;
  }
};

export const formatSubagentError = (error: SubagentError): string => {
  const subject = primarySubject(error);
  return subject === undefined
    ? `${error._tag}: ${error.message}`
    : `${error._tag} (${subject}): ${error.message}`;
};
