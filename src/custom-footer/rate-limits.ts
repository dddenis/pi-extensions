import {
  Data,
  DateTime,
  Duration,
  Effect,
  Either,
  Option,
  Schema,
} from "effect";

export const INITIALIZE_REQUEST_ID = 1;
export const RATE_LIMITS_REQUEST_ID = 2;

export interface RateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins?: number | null;
  readonly resetsAt?: number | null;
}

export interface RateLimitSnapshot {
  readonly limitId?: string | null;
  readonly limitName?: string | null;
  readonly primary?: RateLimitWindow | null;
  readonly secondary?: RateLimitWindow | null;
}

export interface AccountRateLimitsResponse {
  readonly rateLimits?: RateLimitSnapshot | null;
  readonly rateLimitsByLimitId?: Readonly<
    Record<string, RateLimitSnapshot | undefined>
  > | null;
}

export const InitializeRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Literal(INITIALIZE_REQUEST_ID),
  method: Schema.Literal("initialize"),
  params: Schema.Struct({
    clientInfo: Schema.Struct({
      name: Schema.Literal("pi-custom-footer"),
      title: Schema.Literal("Pi Custom Footer"),
      version: Schema.Literal("1"),
    }),
    capabilities: Schema.Struct({
      experimentalApi: Schema.Literal(true),
      optOutNotificationMethods: Schema.Tuple(
        Schema.Literal("remoteControl/status/changed"),
      ),
    }),
  }),
});

export const RateLimitsReadRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Literal(RATE_LIMITS_REQUEST_ID),
  method: Schema.Literal("account/rateLimits/read"),
  params: Schema.Null,
});

export const RateLimitWindowSchema: Schema.Schema<RateLimitWindow> =
  Schema.Struct({
    usedPercent: Schema.Number,
    windowDurationMins: Schema.optional(Schema.NullOr(Schema.Number)),
    resetsAt: Schema.optional(Schema.NullOr(Schema.Number)),
  });

export const RateLimitSnapshotSchema: Schema.Schema<RateLimitSnapshot> =
  Schema.Struct({
    limitId: Schema.optional(Schema.NullOr(Schema.String)),
    limitName: Schema.optional(Schema.NullOr(Schema.String)),
    primary: Schema.optional(Schema.NullOr(RateLimitWindowSchema)),
    secondary: Schema.optional(Schema.NullOr(RateLimitWindowSchema)),
  });

export const AccountRateLimitsResponseSchema: Schema.Schema<AccountRateLimitsResponse> =
  Schema.Struct({
    rateLimits: Schema.optional(Schema.NullOr(RateLimitSnapshotSchema)),
    rateLimitsByLimitId: Schema.optional(
      Schema.NullOr(
        Schema.Record({
          key: Schema.String,
          value: Schema.UndefinedOr(RateLimitSnapshotSchema),
        }),
      ),
    ),
  });

export type JsonRpcValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonRpcValue>
  | { readonly [key: string]: JsonRpcValue };

export const JsonRpcValueSchema: Schema.Schema<JsonRpcValue> = Schema.suspend(
  () =>
    Schema.Union(
      Schema.Null,
      Schema.Boolean,
      Schema.Number,
      Schema.String,
      Schema.Array(JsonRpcValueSchema),
      Schema.Record({ key: Schema.String, value: JsonRpcValueSchema }),
    ),
);

export interface InitializeResult {
  readonly [key: string]: JsonRpcValue;
}

export const InitializeResultSchema: Schema.Schema<InitializeResult> =
  Schema.Record({ key: Schema.String, value: JsonRpcValueSchema });

export const JsonRpcErrorSchema = Schema.Struct({
  code: Schema.optional(Schema.Number),
  message: Schema.String,
  data: Schema.optional(JsonRpcValueSchema),
});

export const JsonRpcSuccessEnvelopeSchema = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  id: Schema.Union(Schema.Number, Schema.String, Schema.Null),
  result: JsonRpcValueSchema,
});

export const JsonRpcErrorEnvelopeSchema = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  id: Schema.Union(Schema.Number, Schema.String, Schema.Null),
  error: JsonRpcErrorSchema,
});

export const JsonRpcEnvelopeSchema = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  id: Schema.Union(Schema.Number, Schema.String, Schema.Null),
  result: Schema.optional(JsonRpcValueSchema),
  error: Schema.optional(JsonRpcValueSchema),
});

const JsonRpcEnvelopeLineSchema = Schema.parseJson(JsonRpcEnvelopeSchema);

type ProtocolErrorReason = "json-rpc-error" | "invalid-result" | "unavailable";

export class RateLimitProtocolError extends Data.TaggedError(
  "RateLimitProtocolError",
)<{
  readonly requestId: number;
  readonly reason: ProtocolErrorReason;
  readonly message: string;
  readonly code?: number;
  readonly detail?: string;
}> {}

const initializeRequest: Schema.Schema.Type<typeof InitializeRequestSchema> = {
  jsonrpc: "2.0",
  id: INITIALIZE_REQUEST_ID,
  method: "initialize",
  params: {
    clientInfo: {
      name: "pi-custom-footer",
      title: "Pi Custom Footer",
      version: "1",
    },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: ["remoteControl/status/changed"],
    },
  },
};

const rateLimitsReadRequest: Schema.Schema.Type<
  typeof RateLimitsReadRequestSchema
> = {
  jsonrpc: "2.0",
  id: RATE_LIMITS_REQUEST_ID,
  method: "account/rateLimits/read",
  params: null,
};

export const encodeInitializeRequest = (): string =>
  JSON.stringify(Schema.encodeSync(InitializeRequestSchema)(initializeRequest));

export const encodeRateLimitsReadRequest = (): string =>
  JSON.stringify(
    Schema.encodeSync(RateLimitsReadRequestSchema)(rateLimitsReadRequest),
  );

const decodeEnvelope = (
  line: string,
): Effect.Effect<
  Option.Option<Schema.Schema.Type<typeof JsonRpcEnvelopeSchema>>
> =>
  Schema.decodeUnknown(JsonRpcEnvelopeLineSchema)(line).pipe(
    Effect.match({
      onFailure: () => Option.none(),
      onSuccess: Option.some,
    }),
  );

const matchingEnvelope = (
  line: string,
  requestId: number,
): Effect.Effect<
  Option.Option<Schema.Schema.Type<typeof JsonRpcEnvelopeSchema>>
> =>
  decodeEnvelope(line).pipe(
    Effect.map(Option.filter((envelope) => envelope.id === requestId)),
  );

const protocolErrorFromEnvelope = (
  envelope: Schema.Schema.Type<typeof JsonRpcEnvelopeSchema>,
  requestId: number,
): Effect.Effect<never, RateLimitProtocolError> =>
  Schema.decodeUnknown(JsonRpcErrorSchema)(envelope.error).pipe(
    Effect.mapError(
      (cause) =>
        new RateLimitProtocolError({
          requestId,
          reason: "json-rpc-error",
          message: `Invalid JSON-RPC error response for request ${requestId}`,
          detail: String(cause),
        }),
    ),
    Effect.flatMap((error) =>
      Effect.fail(
        new RateLimitProtocolError({
          requestId,
          reason: "json-rpc-error",
          message: error.message,
          code: error.code,
        }),
      ),
    ),
  );

const decodeCorrelatedResult = <A, I>(
  schema: Schema.Schema<A, I>,
  result: unknown,
  requestId: number,
): Effect.Effect<A, RateLimitProtocolError> =>
  Schema.decodeUnknown(schema)(result).pipe(
    Effect.mapError(
      (cause) =>
        new RateLimitProtocolError({
          requestId,
          reason: "invalid-result",
          message: `Invalid JSON-RPC result for request ${requestId}`,
          detail: String(cause),
        }),
    ),
  );

export const decodeInitializeJsonRpcLine = (
  line: string,
): Effect.Effect<Option.Option<InitializeResult>, RateLimitProtocolError> =>
  matchingEnvelope(line, INITIALIZE_REQUEST_ID).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (envelope) =>
          Object.hasOwn(envelope, "error")
            ? protocolErrorFromEnvelope(envelope, INITIALIZE_REQUEST_ID)
            : Object.hasOwn(envelope, "result")
              ? decodeCorrelatedResult(
                  InitializeResultSchema,
                  envelope.result,
                  INITIALIZE_REQUEST_ID,
                ).pipe(Effect.map(Option.some))
              : Effect.fail(
                  new RateLimitProtocolError({
                    requestId: INITIALIZE_REQUEST_ID,
                    reason: "invalid-result",
                    message: `Invalid JSON-RPC result for request ${INITIALIZE_REQUEST_ID}`,
                  }),
                ),
      }),
    ),
  );

const hasUsableWindow = (snapshot: RateLimitSnapshot): boolean =>
  snapshot.primary != null || snapshot.secondary != null;

export function selectCodexRateLimit(
  response: AccountRateLimitsResponse,
): RateLimitSnapshot | null {
  const byId = response.rateLimitsByLimitId;
  const exact = byId?.codex;
  if (exact !== undefined) return exact;

  if (byId !== null && byId !== undefined) {
    for (const [limitId, snapshot] of Object.entries(byId)) {
      if (limitId.startsWith("codex") && snapshot !== undefined) {
        return snapshot;
      }
    }
  }

  return response.rateLimits ?? null;
}

const ensureUsableResponse = (
  response: AccountRateLimitsResponse,
): Effect.Effect<AccountRateLimitsResponse, RateLimitProtocolError> => {
  const selected = selectCodexRateLimit(response);
  return selected !== null && hasUsableWindow(selected)
    ? Effect.succeed(response)
    : Effect.fail(
        new RateLimitProtocolError({
          requestId: RATE_LIMITS_REQUEST_ID,
          reason: "unavailable",
          message: "Codex rate limits are unavailable",
        }),
      );
};

export const decodeRateLimitsJsonRpcLine = (
  line: string,
): Effect.Effect<
  Option.Option<AccountRateLimitsResponse>,
  RateLimitProtocolError
> =>
  matchingEnvelope(line, RATE_LIMITS_REQUEST_ID).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (envelope) =>
          Object.hasOwn(envelope, "error")
            ? protocolErrorFromEnvelope(envelope, RATE_LIMITS_REQUEST_ID)
            : Object.hasOwn(envelope, "result")
              ? decodeCorrelatedResult(
                  AccountRateLimitsResponseSchema,
                  envelope.result,
                  RATE_LIMITS_REQUEST_ID,
                ).pipe(
                  Effect.flatMap(ensureUsableResponse),
                  Effect.map(Option.some),
                )
              : Effect.fail(
                  new RateLimitProtocolError({
                    requestId: RATE_LIMITS_REQUEST_ID,
                    reason: "invalid-result",
                    message: `Invalid JSON-RPC result for request ${RATE_LIMITS_REQUEST_ID}`,
                  }),
                ),
      }),
    ),
  );

const formatReset = (
  resetsAtEpochSeconds: number,
  now: DateTime.DateTime,
): Option.Option<string> =>
  DateTime.make(resetsAtEpochSeconds * 1_000).pipe(
    Option.map((target) => DateTime.distanceDurationEither(now, target)),
    Option.map(
      Either.match({
        onLeft: () => "now",
        onRight: (remaining) => {
          const totalMinutes = Math.floor(Duration.toMinutes(remaining));
          if (totalMinutes < 1) return "now";

          const days = Math.floor(totalMinutes / (24 * 60));
          const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
          const minutes = totalMinutes % 60;

          if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
          if (hours > 0)
            return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
          return `${minutes}m`;
        },
      }),
    ),
  );

const formatWindow = (
  label: string,
  window: RateLimitWindow | null | undefined,
  now: DateTime.DateTime,
): Option.Option<string> => {
  if (window == null) return Option.none();

  const remainingPercent = Math.max(
    0,
    Math.min(100, Math.round(100 - window.usedPercent)),
  );
  const reset =
    window.resetsAt == null
      ? Option.none<string>()
      : formatReset(window.resetsAt, now);

  return Option.some(
    `${label} ${remainingPercent}%${Option.match(reset, {
      onNone: () => "",
      onSome: (value) => ` ↺${value}`,
    })}`,
  );
};

export function formatOpenAiRateLimitStatus(
  snapshot: RateLimitSnapshot,
  now: DateTime.DateTime,
): string {
  const windows = [
    formatWindow("5h", snapshot.primary, now),
    formatWindow("wk", snapshot.secondary, now),
  ].flatMap(Option.toArray);

  return windows.length === 0
    ? "OpenAI limits unavailable"
    : `OpenAI ${windows.join(" | ")}`;
}
