import { Effect, Schema } from "effect";
import { PiEventStreamError } from "./errors";
import {
  type CompletionResult,
  CompletionResultSchema,
  type RunUsage,
} from "./schemas";

const SessionEventSchema = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.String,
});

const MessageStartEventSchema = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({ role: Schema.String }),
});

const JsonObjectSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const ToolCallSchema = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: JsonObjectSchema,
  thoughtSignature: Schema.optional(Schema.String),
});

const AssistantContentSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
    textSignature: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("thinking"),
    thinking: Schema.String,
    thinkingSignature: Schema.optional(Schema.String),
    redacted: Schema.optional(Schema.Boolean),
  }),
  ToolCallSchema,
);

const UsageSchema = Schema.Struct({
  input: Schema.NonNegativeInt,
  output: Schema.NonNegativeInt,
  cacheRead: Schema.NonNegativeInt,
  cacheWrite: Schema.NonNegativeInt,
  cacheWrite1h: Schema.optional(Schema.NonNegativeInt),
  reasoning: Schema.optional(Schema.NonNegativeInt),
  totalTokens: Schema.NonNegativeInt,
  cost: Schema.Struct({
    input: Schema.NonNegative,
    output: Schema.NonNegative,
    cacheRead: Schema.NonNegative,
    cacheWrite: Schema.NonNegative,
    total: Schema.NonNegative,
  }),
});

const AssistantMessageCommonFields = {
  role: Schema.Literal("assistant"),
  content: Schema.Array(AssistantContentSchema),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  usage: UsageSchema,
  timestamp: Schema.NonNegative,
};

const SuccessfulAssistantMessageSchema = Schema.Struct({
  ...AssistantMessageCommonFields,
  stopReason: Schema.Literal("stop", "length", "toolUse"),
  errorMessage: Schema.optional(Schema.String),
});

const FailedAssistantMessageSchema = Schema.Struct({
  ...AssistantMessageCommonFields,
  stopReason: Schema.Literal("error", "aborted"),
  errorMessage: Schema.String,
});

const AssistantMessageSchema = Schema.Union(
  SuccessfulAssistantMessageSchema,
  FailedAssistantMessageSchema,
);

const MessageUpdateEnvelopeSchema = Schema.Struct({
  type: Schema.Literal("message_update"),
  message: AssistantMessageSchema,
  assistantMessageEvent: Schema.Struct({ type: Schema.String }),
});

const KnownAssistantMessageEventSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("start"),
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("text_start"),
    contentIndex: Schema.NonNegativeInt,
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("text_delta"),
    contentIndex: Schema.NonNegativeInt,
    delta: Schema.String,
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("text_end"),
    contentIndex: Schema.NonNegativeInt,
    content: Schema.String,
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_start"),
    contentIndex: Schema.NonNegativeInt,
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_delta"),
    contentIndex: Schema.NonNegativeInt,
    delta: Schema.String,
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_end"),
    contentIndex: Schema.NonNegativeInt,
    content: Schema.String,
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_start"),
    contentIndex: Schema.NonNegativeInt,
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_delta"),
    contentIndex: Schema.NonNegativeInt,
    delta: Schema.String,
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_end"),
    contentIndex: Schema.NonNegativeInt,
    toolCall: ToolCallSchema,
    partial: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
    reason: Schema.Literal("stop", "length", "toolUse"),
    message: SuccessfulAssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    reason: Schema.Literal("aborted", "error"),
    error: FailedAssistantMessageSchema,
  }),
);

const KnownMessageUpdateSchema = Schema.Struct({
  type: Schema.Literal("message_update"),
  message: AssistantMessageSchema,
  assistantMessageEvent: KnownAssistantMessageEventSchema,
});

const ToolStartEventSchema = Schema.Struct({
  type: Schema.Literal("tool_execution_start"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.Unknown,
});

const ToolUpdateEventSchema = Schema.Struct({
  type: Schema.Literal("tool_execution_update"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.Unknown,
  partialResult: Schema.Unknown,
});

const MessageEndEnvelopeSchema = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: Schema.Struct({ role: Schema.String }),
});

const AssistantMessageEndSchema = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Unknown),
    usage: UsageSchema,
    stopReason: Schema.Literal("stop", "length", "toolUse", "error", "aborted"),
    errorMessage: Schema.optional(Schema.String),
  }),
});

const ToolEndEventSchema = Schema.Struct({
  type: Schema.Literal("tool_execution_end"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  result: Schema.Unknown,
  isError: Schema.Boolean,
});

const CompletionToolResultSchema = Schema.Struct({
  content: Schema.Tuple(
    Schema.Struct({
      type: Schema.Literal("text"),
      text: Schema.String,
    }),
  ),
  details: CompletionResultSchema,
  terminate: Schema.Literal(true),
}).pipe(
  Schema.filter(
    (result) =>
      result.content[0].text ===
      `Subagent completion recorded: ${result.details.status}`,
    { description: "an exact structured subagent completion result" },
  ),
);

const AgentSettledEventSchema = Schema.Struct({
  type: Schema.Literal("agent_settled"),
});

const decodeSession = Schema.decodeUnknownSync(SessionEventSchema);
const decodeMessageStart = Schema.decodeUnknownSync(MessageStartEventSchema);
const decodeMessageUpdateEnvelope = Schema.decodeUnknownSync(
  MessageUpdateEnvelopeSchema,
);
const decodeKnownMessageUpdate = Schema.decodeUnknownSync(
  KnownMessageUpdateSchema,
);
const decodeToolStart = Schema.decodeUnknownSync(ToolStartEventSchema);
const decodeToolUpdate = Schema.decodeUnknownSync(ToolUpdateEventSchema);
const decodeMessageEndEnvelope = Schema.decodeUnknownSync(
  MessageEndEnvelopeSchema,
);
const decodeAssistantMessageEnd = Schema.decodeUnknownSync(
  AssistantMessageEndSchema,
);
const decodeToolCall = Schema.decodeUnknownSync(ToolCallSchema);
const decodeToolEnd = Schema.decodeUnknownSync(ToolEndEventSchema);
const decodeCompletionToolResult = Schema.decodeUnknownSync(
  CompletionToolResultSchema,
  { onExcessProperty: "error" },
);
const decodeAgentSettled = Schema.decodeUnknownSync(AgentSettledEventSchema);

const emptyUsage = (): RunUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
});

const copyUsage = (usage: RunUsage): RunUsage => ({ ...usage });

const copyCompletion = (completion: CompletionResult): CompletionResult => ({
  status: completion.status,
  summary: completion.summary,
  ...(completion.reportPath === undefined
    ? {}
    : { reportPath: completion.reportPath }),
});

const objectType = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return undefined;
  }
  return typeof value.type === "string" ? value.type : undefined;
};

export const SAFE_TOOL_PREVIEW = "started";

export type PiProgressEvent =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly preview: string }
  | { readonly type: "usage"; readonly usage: RunUsage }
  | { readonly type: "settled" }
  | { readonly type: "ignored" };

export interface ProcessExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface PiEventAccumulatorSnapshot {
  readonly sessionId?: string;
  readonly usage: RunUsage;
  readonly settled: boolean;
  readonly completion?: CompletionResult;
  readonly completionInvalidated: boolean;
  readonly providerFailure?: {
    readonly stopReason: "error" | "aborted";
    readonly message?: string;
  };
}

export type PiEventFinalization =
  | {
      readonly status: "completed";
      readonly sessionId?: string;
      readonly completion: CompletionResult;
      readonly usage: RunUsage;
    }
  | {
      readonly status: "failed";
      readonly sessionId?: string;
      readonly reason: string;
      readonly usage: RunUsage;
    };

export interface PiEventAccumulator {
  readonly consume: (
    rawLine: string,
  ) => Effect.Effect<PiProgressEvent, PiEventStreamError>;
  readonly snapshot: Effect.Effect<PiEventAccumulatorSnapshot>;
  readonly finalize: (
    exit: ProcessExitStatus,
  ) => Effect.Effect<PiEventFinalization>;
}

interface PendingCompletion {
  readonly toolCallId: string;
}

interface MutableAccumulatorState {
  lineNumber: number;
  sessionId?: string;
  usage: RunUsage;
  settled: boolean;
  pendingCompletion?: PendingCompletion;
  completion?: CompletionResult;
  completionInvalidated: boolean;
  streamFailed: boolean;
  providerFailure?: {
    readonly stopReason: "error" | "aborted";
    readonly message?: string;
  };
}

const snapshotState = (
  state: MutableAccumulatorState,
): PiEventAccumulatorSnapshot => ({
  ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
  usage: copyUsage(state.usage),
  settled: state.settled,
  ...(state.completion === undefined
    ? {}
    : { completion: copyCompletion(state.completion) }),
  completionInvalidated: state.completionInvalidated,
  ...(state.providerFailure === undefined
    ? {}
    : { providerFailure: { ...state.providerFailure } }),
});

const invalidateCompletion = (state: MutableAccumulatorState): void => {
  state.pendingCompletion = undefined;
  state.completion = undefined;
  state.completionInvalidated = true;
};

const markAssistantWork = (state: MutableAccumulatorState): void => {
  state.settled = false;
  if (state.pendingCompletion !== undefined || state.completion !== undefined) {
    invalidateCompletion(state);
  }
};

const addUsage = (
  state: MutableAccumulatorState,
  value: Schema.Schema.Type<typeof UsageSchema>,
): void => {
  state.usage = {
    input: state.usage.input + value.input,
    output: state.usage.output + value.output,
    cacheRead: state.usage.cacheRead + value.cacheRead,
    cacheWrite: state.usage.cacheWrite + value.cacheWrite,
    cost: state.usage.cost + value.cost.total,
    turns: state.usage.turns + 1,
  };
};

const toolCalls = (
  content: ReadonlyArray<unknown>,
): ReadonlyArray<Schema.Schema.Type<typeof ToolCallSchema>> => {
  const calls: Array<Schema.Schema.Type<typeof ToolCallSchema>> = [];
  for (const item of content) {
    if (objectType(item) !== "toolCall") continue;
    calls.push(decodeToolCall(item));
  }
  return calls;
};

const consumeValue = (
  state: MutableAccumulatorState,
  value: unknown,
): PiProgressEvent => {
  switch (objectType(value)) {
    case "session": {
      const event = decodeSession(value);
      state.sessionId = event.id;
      return { type: "session", sessionId: event.id };
    }
    case "message_start": {
      const event = decodeMessageStart(value);
      if (event.message.role === "assistant") markAssistantWork(state);
      return { type: "ignored" };
    }
    case "message_update": {
      const envelope = decodeMessageUpdateEnvelope(value);
      markAssistantWork(state);
      switch (envelope.assistantMessageEvent.type) {
        case "start":
        case "text_start":
        case "text_delta":
        case "text_end":
        case "thinking_start":
        case "thinking_delta":
        case "thinking_end":
        case "toolcall_start":
        case "toolcall_delta":
        case "toolcall_end":
        case "done":
        case "error": {
          const event = decodeKnownMessageUpdate(value);
          return event.assistantMessageEvent.type === "text_delta"
            ? {
                type: "assistant",
                text: event.assistantMessageEvent.delta,
              }
            : { type: "ignored" };
        }
        default:
          return { type: "ignored" };
      }
    }
    case "tool_execution_start": {
      const event = decodeToolStart(value);
      state.settled = false;
      if (state.completion !== undefined) {
        invalidateCompletion(state);
      } else if (
        state.pendingCompletion !== undefined &&
        (state.pendingCompletion.toolCallId !== event.toolCallId ||
          event.toolName !== "complete_subagent")
      ) {
        invalidateCompletion(state);
      }
      return {
        type: "tool",
        name: event.toolName,
        preview: SAFE_TOOL_PREVIEW,
      };
    }
    case "tool_execution_update": {
      const event = decodeToolUpdate(value);
      state.settled = false;
      if (state.completion !== undefined) {
        invalidateCompletion(state);
      } else if (
        state.pendingCompletion !== undefined &&
        (state.pendingCompletion.toolCallId !== event.toolCallId ||
          event.toolName !== "complete_subagent")
      ) {
        invalidateCompletion(state);
      }
      return { type: "ignored" };
    }
    case "message_end": {
      const envelope = decodeMessageEndEnvelope(value);
      if (envelope.message.role !== "assistant") return { type: "ignored" };
      const event = decodeAssistantMessageEnd(value);
      markAssistantWork(state);
      addUsage(state, event.message.usage);
      if (
        event.message.stopReason === "error" ||
        event.message.stopReason === "aborted"
      ) {
        state.providerFailure = {
          stopReason: event.message.stopReason,
          ...(event.message.errorMessage === undefined
            ? {}
            : { message: event.message.errorMessage }),
        };
      }
      const calls = toolCalls(event.message.content);
      if (
        calls.length === 1 &&
        calls[0]?.name === "complete_subagent" &&
        !state.completionInvalidated
      ) {
        state.pendingCompletion = { toolCallId: calls[0].id };
      }
      return { type: "usage", usage: copyUsage(state.usage) };
    }
    case "tool_execution_end": {
      const event = decodeToolEnd(value);
      state.settled = false;
      if (state.completion !== undefined) {
        invalidateCompletion(state);
        return { type: "ignored" };
      }
      if (state.pendingCompletion === undefined) return { type: "ignored" };
      if (
        state.pendingCompletion.toolCallId !== event.toolCallId ||
        event.toolName !== "complete_subagent"
      ) {
        invalidateCompletion(state);
        return { type: "ignored" };
      }
      state.pendingCompletion = undefined;
      if (event.isError) return { type: "ignored" };
      const result = decodeCompletionToolResult(event.result);
      state.completion = copyCompletion(result.details);
      return { type: "ignored" };
    }
    case "agent_settled": {
      decodeAgentSettled(value);
      state.settled = true;
      return { type: "settled" };
    }
    default:
      return { type: "ignored" };
  }
};

const failedFinalization = (
  state: MutableAccumulatorState,
  reason: string,
): PiEventFinalization => ({
  status: "failed",
  ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
  reason,
  usage: copyUsage(state.usage),
});

const finalizeState = (
  state: MutableAccumulatorState,
  exit: ProcessExitStatus,
): PiEventFinalization => {
  if (exit.code !== 0 || exit.signal !== null) {
    const description =
      exit.signal === null
        ? `Pi process exited with code ${String(exit.code)}`
        : `Pi process exited with signal ${exit.signal}`;
    return failedFinalization(state, description);
  }
  if (state.streamFailed) {
    return failedFinalization(
      state,
      "Pi event stream contains malformed events",
    );
  }
  if (state.providerFailure !== undefined) {
    return failedFinalization(
      state,
      state.providerFailure.message ??
        `Provider stopped with ${state.providerFailure.stopReason}`,
    );
  }
  if (!state.settled) {
    return failedFinalization(state, "Pi event stream did not settle");
  }
  if (state.completionInvalidated) {
    return failedFinalization(
      state,
      "Structured completion was invalidated by later work",
    );
  }
  if (state.completion === undefined) {
    return failedFinalization(
      state,
      "Pi event stream has no valid structured completion",
    );
  }
  return {
    status: "completed",
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    completion: copyCompletion(state.completion),
    usage: copyUsage(state.usage),
  };
};

export const makePiEventAccumulator = (): PiEventAccumulator => {
  const state: MutableAccumulatorState = {
    lineNumber: 0,
    usage: emptyUsage(),
    settled: false,
    completionInvalidated: false,
    streamFailed: false,
  };

  return {
    consume: (rawLine) =>
      Effect.try({
        try: (): PiProgressEvent => {
          state.lineNumber += 1;
          if (rawLine.trim().length === 0) return { type: "ignored" };
          const value: unknown = JSON.parse(rawLine);
          return consumeValue(state, value);
        },
        catch: (cause) => {
          state.streamFailed = true;
          return new PiEventStreamError({
            message:
              cause instanceof Error ? cause.message : "Invalid Pi JSON event",
            lineNumber: state.lineNumber,
            rawLine,
          });
        },
      }),
    snapshot: Effect.sync(() => snapshotState(state)),
    finalize: (exit) => Effect.sync(() => finalizeState(state, exit)),
  };
};
