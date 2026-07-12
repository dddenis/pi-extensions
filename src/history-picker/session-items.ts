import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import type { HistoryItem } from "./types";

const JsonValueSchema = Schema.parseJson(Schema.Unknown);
const EntryDiscriminatorSchema = Schema.Struct({ type: Schema.String });
const SessionLineSchema = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.optional(Schema.Number),
  id: Schema.String,
  timestamp: Schema.String,
  cwd: Schema.String,
  parentSession: Schema.optional(Schema.String),
});
const TextBlockSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optional(Schema.String),
});
const ImageBlockSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
const ThinkingBlockSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optional(Schema.String),
  redacted: Schema.optional(Schema.Boolean),
});
const ToolCallBlockSchema = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  thoughtSignature: Schema.optional(Schema.String),
});
const UserContentSchema = Schema.Union(
  Schema.String,
  Schema.Array(Schema.Union(TextBlockSchema, ImageBlockSchema)),
);
const UserMessageSchema = Schema.Struct({
  role: Schema.Literal("user"),
  content: UserContentSchema,
  timestamp: Schema.optional(Schema.Number),
});
const UsageSchema = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  cacheWrite1h: Schema.optional(Schema.Number),
  reasoning: Schema.optional(Schema.Number),
  totalTokens: Schema.Number,
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
});
const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(
    Schema.Union(TextBlockSchema, ThinkingBlockSchema, ToolCallBlockSchema),
  ),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  responseModel: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  usage: UsageSchema,
  stopReason: Schema.Literal("stop", "length", "toolUse", "error", "aborted"),
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
});
const ToolResultMessageSchema = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union(TextBlockSchema, ImageBlockSchema)),
  details: Schema.optional(Schema.Unknown),
  isError: Schema.Boolean,
  timestamp: Schema.optional(Schema.Number),
});
const BashExecutionMessageSchema = Schema.Struct({
  role: Schema.Literal("bashExecution"),
  command: Schema.String,
  output: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cancelled: Schema.Boolean,
  truncated: Schema.Boolean,
  fullOutputPath: Schema.optional(Schema.String),
  excludeFromContext: Schema.optional(Schema.Boolean),
  timestamp: Schema.optional(Schema.Number),
});
const CustomMessageSchema = Schema.Struct({
  role: Schema.Literal("custom"),
  customType: Schema.String,
  content: UserContentSchema,
  display: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
  timestamp: Schema.optional(Schema.Number),
});
const BranchSummaryMessageSchema = Schema.Struct({
  role: Schema.Literal("branchSummary"),
  summary: Schema.String,
  fromId: Schema.String,
  timestamp: Schema.optional(Schema.Number),
});
const CompactionSummaryMessageSchema = Schema.Struct({
  role: Schema.Literal("compactionSummary"),
  summary: Schema.String,
  tokensBefore: Schema.Number,
  timestamp: Schema.optional(Schema.Number),
});
const AgentMessageSchema = Schema.Union(
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  BashExecutionMessageSchema,
  CustomMessageSchema,
  BranchSummaryMessageSchema,
  CompactionSummaryMessageSchema,
);
const MessageLineSchema = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  message: AgentMessageSchema,
});

type UserContent = Schema.Schema.Type<typeof UserContentSchema>;
type MessageLine = Schema.Schema.Type<typeof MessageLineSchema>;

export class MalformedSessionJsonlError extends Data.TaggedError(
  "MalformedSessionJsonlError",
)<{
  readonly sessionFile: string;
  readonly lineNumber: number;
  readonly message: string;
}> {}

const textFromContent = (content: UserContent): string =>
  typeof content === "string"
    ? content
    : content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

const timestampFromIso = (timestamp: string): number =>
  DateTime.make(timestamp).pipe(
    Option.map(DateTime.toEpochMillis),
    Option.getOrElse(() => 0),
  );

const savedTimestamp = (entry: MessageLine): number =>
  entry.message.timestamp ?? timestampFromIso(entry.timestamp);

const malformedLine = (
  sessionFile: string,
  lineNumber: number,
  cause: unknown,
): MalformedSessionJsonlError =>
  new MalformedSessionJsonlError({
    sessionFile,
    lineNumber,
    message: String(cause),
  });

const decodeAtLine = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  sessionFile: string,
  lineNumber: number,
): Effect.Effect<A, MalformedSessionJsonlError> =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((cause) => malformedLine(sessionFile, lineNumber, cause)),
  );

export const indexCurrentSessionEntries = (
  entries: ReadonlyArray<SessionEntry>,
  sessionFile: string,
  cwd: string,
): ReadonlyArray<HistoryItem> => {
  const items: Array<HistoryItem> = [];

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") {
      continue;
    }

    const text =
      typeof entry.message.content === "string"
        ? entry.message.content
        : entry.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
    if (text.length === 0) {
      continue;
    }

    items.push({
      text,
      timestamp:
        typeof entry.message.timestamp === "number"
          ? entry.message.timestamp
          : timestampFromIso(entry.timestamp),
      sessionFile,
      cwd,
      source: "current",
    });
  }

  return items;
};

export const parseSavedSessionJsonl = (
  jsonl: string,
  sessionFile: string,
  listingCwd: string,
): Effect.Effect<ReadonlyArray<HistoryItem>, MalformedSessionJsonlError> =>
  Effect.gen(function* () {
    let headerCwd: string | undefined;
    const projected: Array<Pick<HistoryItem, "text" | "timestamp">> = [];
    const physicalLines = jsonl.split(/\r?\n/);

    for (let index = 0; index < physicalLines.length; index += 1) {
      const line = physicalLines[index] ?? "";
      if (line.trim().length === 0) {
        continue;
      }

      const lineNumber = index + 1;
      const value = yield* decodeAtLine(
        JsonValueSchema,
        line,
        sessionFile,
        lineNumber,
      );
      const discriminator = yield* decodeAtLine(
        EntryDiscriminatorSchema,
        value,
        sessionFile,
        lineNumber,
      );

      if (discriminator.type === "session") {
        const header = yield* decodeAtLine(
          SessionLineSchema,
          value,
          sessionFile,
          lineNumber,
        );
        if (headerCwd === undefined) {
          headerCwd = header.cwd;
        }
        continue;
      }

      if (discriminator.type !== "message") {
        continue;
      }

      const messageEntry = yield* decodeAtLine(
        MessageLineSchema,
        value,
        sessionFile,
        lineNumber,
      );
      if (messageEntry.message.role !== "user") {
        continue;
      }

      const text = textFromContent(messageEntry.message.content);
      if (text.length > 0) {
        projected.push({ text, timestamp: savedTimestamp(messageEntry) });
      }
    }

    const cwd =
      headerCwd === undefined || headerCwd.length === 0
        ? listingCwd
        : headerCwd;
    return projected.map(({ text, timestamp }) => ({
      text,
      timestamp,
      sessionFile,
      cwd,
      source: "saved" as const,
    }));
  });
