import { Effect } from "effect";
import { FileSystemService } from "../services/file-system";
import { CompletionValidationError } from "./errors";
import {
  type CompletionResult,
  decodeCompletion,
  type SemanticStatus,
} from "./schemas";

export interface CompletionToolResult {
  readonly content: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
  }>;
  readonly details: CompletionResult;
  readonly terminate: true;
}

const optionalStringField = (
  input: unknown,
  field: "status" | "summary" | "reportPath",
): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  switch (field) {
    case "status":
      return "status" in input && typeof input.status === "string"
        ? input.status
        : undefined;
    case "summary":
      return "summary" in input && typeof input.summary === "string"
        ? input.summary
        : undefined;
    case "reportPath":
      return "reportPath" in input && typeof input.reportPath === "string"
        ? input.reportPath
        : undefined;
  }
};

const validationError = (
  input: unknown,
  message: string,
): CompletionValidationError =>
  new CompletionValidationError({
    message,
    status: optionalStringField(input, "status"),
    summary: optionalStringField(input, "summary"),
    reportPath: optionalStringField(input, "reportPath"),
  });

const decodeInput = (
  input: unknown,
): Effect.Effect<CompletionResult, CompletionValidationError> =>
  Effect.try({
    try: () => decodeCompletion(input),
    catch: () => validationError(input, "Invalid structured completion"),
  });

const canonicalReportPath = (
  input: unknown,
  reportPath: string,
): Effect.Effect<string, CompletionValidationError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const metadata = yield* fileSystem
      .stat(reportPath)
      .pipe(
        Effect.mapError(() =>
          validationError(input, "Completion report does not exist"),
        ),
      );
    if (metadata.kind !== "file") {
      return yield* validationError(
        input,
        "Completion report must be a regular file",
      );
    }
    return yield* fileSystem
      .realPath(reportPath)
      .pipe(
        Effect.mapError(() =>
          validationError(input, "Completion report path cannot be resolved"),
        ),
      );
  });

const toolResult = (
  status: SemanticStatus,
  summary: string,
  reportPath?: string,
): CompletionToolResult => ({
  content: [{ type: "text", text: `Subagent completion recorded: ${status}` }],
  details: {
    status,
    summary,
    ...(reportPath === undefined ? {} : { reportPath }),
  },
  terminate: true,
});

export const completeSubagent = (
  input: unknown,
): Effect.Effect<
  CompletionToolResult,
  CompletionValidationError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const completion = yield* decodeInput(input);
    if (completion.reportPath === undefined) {
      return toolResult(completion.status, completion.summary);
    }
    const reportPath = yield* canonicalReportPath(input, completion.reportPath);
    return toolResult(completion.status, completion.summary, reportPath);
  });
