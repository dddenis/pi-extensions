import { Effect, Schema } from "effect";
import { PiEventStreamError } from "./errors";
import {
  COMPLETION_SUMMARY_MAX_CODE_POINTS,
  type CompletionResult,
  CompletionResultSchema,
  type RunUsage,
} from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";

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

const PositiveIntSchema = Schema.Int.pipe(Schema.positive());

const AgentEndEventSchema = Schema.Struct({
  type: Schema.Literal("agent_end"),
  messages: Schema.Array(Schema.Unknown),
  willRetry: Schema.Boolean,
});

const AutoRetryStartEventSchema = Schema.Struct({
  type: Schema.Literal("auto_retry_start"),
  attempt: PositiveIntSchema,
  maxAttempts: PositiveIntSchema,
  delayMs: Schema.NonNegativeInt,
  errorMessage: Schema.String,
});

const AutoRetryEndEventSchema = Schema.Struct({
  type: Schema.Literal("auto_retry_end"),
  success: Schema.Boolean,
  attempt: PositiveIntSchema,
  finalError: Schema.optional(Schema.String),
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
const decodeAgentEnd = Schema.decodeUnknownSync(AgentEndEventSchema);
const decodeAutoRetryStart = Schema.decodeUnknownSync(
  AutoRetryStartEventSchema,
);
const decodeAutoRetryEnd = Schema.decodeUnknownSync(AutoRetryEndEventSchema);
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

interface ProviderFailure {
  readonly stopReason: "error" | "aborted";
  readonly message?: string;
}

interface MutableProviderFailure extends ProviderFailure {
  readonly observedAtLine: number;
  retryAnnounced: boolean;
  terminalDisposition: boolean;
}

interface ActiveRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly sourceFailureLine: number;
  failed: boolean;
}

export interface PiEventAccumulatorSnapshot {
  readonly sessionId?: string;
  readonly usage: RunUsage;
  readonly settled: boolean;
  readonly completion?: CompletionResult;
  readonly completionInvalidated: boolean;
  readonly providerFailure?: ProviderFailure;
  readonly recoveredDiagnostics: ReadonlyArray<string>;
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
  providerFailure?: MutableProviderFailure;
  terminalProviderFailure?: ProviderFailure;
  latestAssistantEndLine?: number;
  agentEndObservedAtLine?: number;
  retryExpected: boolean;
  activeRetry?: ActiveRetry;
  lastRetryAttempt?: number;
  retryMaxAttempts?: number;
  recoveredDiagnostics: Array<string>;
}

const authoritativeProviderFailure = (
  state: MutableAccumulatorState,
): ProviderFailure | undefined =>
  state.terminalProviderFailure ?? state.providerFailure;

const snapshotState = (
  state: MutableAccumulatorState,
): PiEventAccumulatorSnapshot => {
  const providerFailure = authoritativeProviderFailure(state);
  return {
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    usage: copyUsage(state.usage),
    settled: state.settled,
    ...(state.completion === undefined
      ? {}
      : { completion: copyCompletion(state.completion) }),
    completionInvalidated: state.completionInvalidated,
    ...(providerFailure === undefined
      ? {}
      : {
          providerFailure: {
            stopReason: providerFailure.stopReason,
            ...(providerFailure.message === undefined
              ? {}
              : { message: providerFailure.message }),
          },
        }),
    recoveredDiagnostics: [...state.recoveredDiagnostics],
  };
};

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

const invalidRetryTransition = (message: string): never => {
  throw new Error(`Invalid Pi retry lifecycle: ${message}`);
};

const boundedDiagnostic = (value: string): string => {
  const sanitized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  const nonEmpty = sanitized.length === 0 ? "Provider failure" : sanitized;
  return Array.from(nonEmpty)
    .slice(0, COMPLETION_SUMMARY_MAX_CODE_POINTS)
    .join("");
};

const recoveredProviderDiagnostic = (
  failure: ProviderFailure,
  attempt: number,
): string =>
  boundedDiagnostic(
    `Recovered provider retry attempt ${String(attempt)}: ${
      failure.message ?? `Provider stopped with ${failure.stopReason}`
    }`,
  );

const preserveTerminalProviderFailure = (
  state: MutableAccumulatorState,
  failure: ProviderFailure,
): void => {
  if (state.terminalProviderFailure !== undefined) return;
  state.terminalProviderFailure = {
    stopReason: failure.stopReason,
    ...(failure.message === undefined ? {} : { message: failure.message }),
  };
};

const recordProviderFailure = (
  state: MutableAccumulatorState,
  failure: ProviderFailure,
): void => {
  if (state.retryExpected) {
    invalidRetryTransition("provider failure arrived before retry start");
  }
  const previousFailure = state.providerFailure;
  if (
    state.activeRetry === undefined &&
    previousFailure !== undefined &&
    !previousFailure.terminalDisposition
  ) {
    invalidRetryTransition("provider failure replaced before disposition");
  }
  if (
    state.activeRetry !== undefined &&
    previousFailure?.terminalDisposition === true
  ) {
    invalidRetryTransition(
      "provider failure replaced after active retry became terminal",
    );
  }
  if (state.activeRetry !== undefined) {
    state.activeRetry.failed = true;
  }
  state.providerFailure = {
    ...failure,
    observedAtLine: state.lineNumber,
    retryAnnounced: false,
    terminalDisposition: false,
  };
};

const consumeAgentEnd = (
  state: MutableAccumulatorState,
  event: Schema.Schema.Type<typeof AgentEndEventSchema>,
): void => {
  if (state.retryExpected) {
    invalidRetryTransition("agent_end repeated before retry start");
  }
  const assistantEndLine = state.latestAssistantEndLine;
  if (
    assistantEndLine === undefined ||
    state.agentEndObservedAtLine === assistantEndLine
  ) {
    invalidRetryTransition("agent_end repeated without new assistant work");
  }

  const currentFailure = state.providerFailure;
  const failure =
    currentFailure?.observedAtLine === assistantEndLine
      ? currentFailure
      : undefined;

  if (!event.willRetry) {
    if (state.activeRetry !== undefined) {
      if (
        !state.activeRetry.failed ||
        failure === undefined ||
        failure.observedAtLine === state.activeRetry.sourceFailureLine
      ) {
        invalidRetryTransition(
          "agent_end ended an active retry before its retry result",
        );
      }
    }
    if (failure !== undefined) {
      failure.terminalDisposition = true;
      if (state.activeRetry === undefined) {
        preserveTerminalProviderFailure(state, failure);
      }
    }
    state.agentEndObservedAtLine = assistantEndLine;
    return;
  }

  if (failure === undefined) {
    invalidRetryTransition("retry announced without provider failure");
  }
  if (failure.terminalDisposition) {
    invalidRetryTransition("retry announced after failure became terminal");
  }
  if (failure.retryAnnounced) {
    invalidRetryTransition("retry announced repeatedly for one failure");
  }
  if (state.activeRetry !== undefined) {
    if (
      !state.activeRetry.failed ||
      failure.observedAtLine === state.activeRetry.sourceFailureLine
    ) {
      invalidRetryTransition("next retry announced without a new failure");
    }
    state.activeRetry = undefined;
  }

  failure.retryAnnounced = true;
  state.retryExpected = true;
  state.agentEndObservedAtLine = assistantEndLine;
};

const consumeAutoRetryStart = (
  state: MutableAccumulatorState,
  event: Schema.Schema.Type<typeof AutoRetryStartEventSchema>,
): void => {
  const failure = state.providerFailure;
  if (
    !state.retryExpected ||
    state.activeRetry !== undefined ||
    failure === undefined ||
    !failure.retryAnnounced
  ) {
    invalidRetryTransition("retry start has no matching announcement");
  }
  const expectedAttempt = (state.lastRetryAttempt ?? 0) + 1;
  if (event.attempt !== expectedAttempt) {
    invalidRetryTransition(
      `retry attempt ${String(event.attempt)} did not follow ${String(
        state.lastRetryAttempt ?? 0,
      )}`,
    );
  }
  if (event.attempt > event.maxAttempts) {
    invalidRetryTransition("retry attempt exceeds maxAttempts");
  }
  if (
    state.retryMaxAttempts !== undefined &&
    state.retryMaxAttempts !== event.maxAttempts
  ) {
    invalidRetryTransition("maxAttempts changed inside one retry chain");
  }
  if (failure.message !== undefined && failure.message !== event.errorMessage) {
    invalidRetryTransition("retry error does not match provider failure");
  }
  if (failure.message === undefined) {
    state.providerFailure = { ...failure, message: event.errorMessage };
  }

  state.retryExpected = false;
  state.lastRetryAttempt = event.attempt;
  state.retryMaxAttempts = event.maxAttempts;
  state.activeRetry = {
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    sourceFailureLine: failure.observedAtLine,
    failed: false,
  };
};

const consumeAutoRetryEnd = (
  state: MutableAccumulatorState,
  event: Schema.Schema.Type<typeof AutoRetryEndEventSchema>,
): void => {
  const active = state.activeRetry;
  const failure = state.providerFailure;
  if (
    state.retryExpected ||
    active === undefined ||
    failure === undefined ||
    event.attempt !== active.attempt
  ) {
    invalidRetryTransition("retry end does not match the active attempt");
  }

  if (event.success) {
    if (active.failed) {
      invalidRetryTransition("failed retry attempt reported success");
    }
    if (event.finalError !== undefined) {
      invalidRetryTransition("successful retry included finalError");
    }
    state.recoveredDiagnostics.push(
      recoveredProviderDiagnostic(failure, active.attempt),
    );
    state.providerFailure = undefined;
  } else {
    const terminalFailure =
      event.finalError === undefined
        ? failure
        : { ...failure, message: event.finalError };
    terminalFailure.terminalDisposition = true;
    state.providerFailure = terminalFailure;
    preserveTerminalProviderFailure(state, terminalFailure);
  }

  state.activeRetry = undefined;
  state.lastRetryAttempt = undefined;
  state.retryMaxAttempts = undefined;
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
        recordProviderFailure(state, {
          stopReason: event.message.stopReason,
          ...(event.message.errorMessage === undefined
            ? {}
            : { message: event.message.errorMessage }),
        });
      }
      const calls = toolCalls(event.message.content);
      if (
        calls.length === 1 &&
        calls[0]?.name === "complete_subagent" &&
        !state.completionInvalidated
      ) {
        state.pendingCompletion = { toolCallId: calls[0].id };
      }
      state.latestAssistantEndLine = state.lineNumber;
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
    case "agent_end": {
      const event = decodeAgentEnd(value);
      consumeAgentEnd(state, event);
      return { type: "ignored" };
    }
    case "auto_retry_start": {
      const event = decodeAutoRetryStart(value);
      consumeAutoRetryStart(state, event);
      return { type: "ignored" };
    }
    case "auto_retry_end": {
      const event = decodeAutoRetryEnd(value);
      consumeAutoRetryEnd(state, event);
      return { type: "ignored" };
    }
    case "agent_settled": {
      decodeAgentSettled(value);
      if (state.retryExpected || state.activeRetry !== undefined) {
        invalidRetryTransition("agent settled while retry remained pending");
      }
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
  const providerFailure = authoritativeProviderFailure(state);
  if (providerFailure !== undefined) {
    return failedFinalization(
      state,
      providerFailure.message ??
        `Provider stopped with ${providerFailure.stopReason}`,
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
    retryExpected: false,
    recoveredDiagnostics: [],
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
