import { describe, it } from "@effect/vitest";
import { DateTime, Effect, Either, Option } from "effect";
import { expect } from "vitest";
import {
  RATE_LIMITS_REQUEST_ID,
  RateLimitProtocolError,
  decodeInitializeJsonRpcLine,
  decodeRateLimitsJsonRpcLine,
  encodeInitializeRequest,
  encodeRateLimitsReadRequest,
  formatOpenAiRateLimitStatus,
  selectCodexRateLimit,
  type AccountRateLimitsResponse,
} from "./rate-limits";

const now = DateTime.make("2026-06-26T16:00:00Z").pipe(Option.getOrThrow);
const nowEpochSeconds = DateTime.toEpochMillis(now) / 1_000;

const usableResponse = (usedPercent = 1): AccountRateLimitsResponse => ({
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent },
  },
});

const rateLimitsLine = (result: unknown, id = RATE_LIMITS_REQUEST_ID): string =>
  JSON.stringify({ id, result });

describe("Codex rate-limit protocol", () => {
  it("encodes the exact initialize and read requests through their schemas", () => {
    expect(encodeInitializeRequest()).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"pi-custom-footer","title":"Pi Custom Footer","version":"1"},"capabilities":{"experimentalApi":true,"optOutNotificationMethods":["remoteControl/status/changed"]}}}',
    );
    expect(encodeRateLimitsReadRequest()).toBe(
      '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":null}',
    );
  });

  it.effect("ignores malformed and unrelated lines", () =>
    Effect.gen(function* () {
      expect(
        Option.isNone(yield* decodeRateLimitsJsonRpcLine("not json")),
      ).toBe(true);
      expect(
        Option.isNone(
          yield* decodeRateLimitsJsonRpcLine(
            rateLimitsLine(
              { rateLimits: { primary: { usedPercent: "bad" } } },
              99,
            ),
          ),
        ),
      ).toBe(true);
      expect(
        Option.isNone(
          yield* decodeInitializeJsonRpcLine(
            JSON.stringify({ id: 2, result: {} }),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    "decodes correlated initialize and nullable rate-limit results",
    () =>
      Effect.gen(function* () {
        const initialized = yield* decodeInitializeJsonRpcLine(
          JSON.stringify({ id: 1, result: { userAgent: "codex" } }),
        );
        expect(Option.isSome(initialized)).toBe(true);

        const decoded = yield* decodeRateLimitsJsonRpcLine(
          rateLimitsLine({
            rateLimits: {
              limitId: null,
              limitName: null,
              primary: {
                usedPercent: 25,
                windowDurationMins: null,
                resetsAt: null,
              },
              secondary: null,
            },
            rateLimitsByLimitId: null,
          }),
        );

        expect(Option.getOrThrow(decoded).rateLimits?.primary).toEqual({
          usedPercent: 25,
          windowDurationMins: null,
          resetsAt: null,
        });
      }),
  );

  it.effect(
    "fails malformed correlated initialize results with a typed protocol error",
    () =>
      Effect.gen(function* () {
        for (const resultPayload of [null, "initialized", ["initialized"]]) {
          const result = yield* Effect.either(
            decodeInitializeJsonRpcLine(
              JSON.stringify({ id: 1, result: resultPayload }),
            ),
          );

          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result)) {
            expect(result.left).toBeInstanceOf(RateLimitProtocolError);
            expect(result.left.reason).toBe("invalid-result");
          }
        }
      }),
  );

  it.effect(
    "fails malformed correlated rate-limit results with a typed protocol error",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.either(
          decodeRateLimitsJsonRpcLine(
            rateLimitsLine({
              rateLimits: { primary: { usedPercent: "bad" } },
            }),
          ),
        );

        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(RateLimitProtocolError);
          expect(result.left.reason).toBe("invalid-result");
        }
      }),
  );

  it.effect("fails matching JSON-RPC errors but ignores unrelated errors", () =>
    Effect.gen(function* () {
      const unrelated = yield* decodeRateLimitsJsonRpcLine(
        JSON.stringify({
          id: 77,
          error: { code: -32_000, message: "unrelated" },
        }),
      );
      expect(Option.isNone(unrelated)).toBe(true);

      const result = yield* Effect.either(
        decodeRateLimitsJsonRpcLine(
          JSON.stringify({
            id: RATE_LIMITS_REQUEST_ID,
            error: {
              code: -32_001,
              message: "rate limits unavailable",
              data: { retryable: false },
            },
          }),
        ),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toMatchObject({
          _tag: "RateLimitProtocolError",
          requestId: RATE_LIMITS_REQUEST_ID,
          reason: "json-rpc-error",
          code: -32_001,
          message: "rate limits unavailable",
        });
      }

      const initializeError = yield* Effect.either(
        decodeInitializeJsonRpcLine(
          JSON.stringify({
            id: 1,
            error: { message: "initialize unavailable" },
          }),
        ),
      );
      expect(Either.isLeft(initializeError)).toBe(true);
      if (Either.isLeft(initializeError)) {
        expect(initializeError.left).toMatchObject({
          requestId: 1,
          reason: "json-rpc-error",
          message: "initialize unavailable",
        });
      }
    }),
  );

  it.effect(
    "rejects schema-valid responses whose selected snapshot has no usable windows",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.either(
          decodeRateLimitsJsonRpcLine(
            rateLimitsLine({
              rateLimits: { limitId: "codex", primary: null, secondary: null },
            }),
          ),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result))
          expect(result.left.reason).toBe("unavailable");
      }),
  );
});

describe("Codex rate-limit selection", () => {
  it("prefers exact codex, then the first defined codex prefix, then top-level", () => {
    const topLevel = { limitId: "top", primary: { usedPercent: 50 } };
    const firstPrefix = {
      limitId: "codex_alpha",
      primary: { usedPercent: 25 },
    };
    const exact = { limitId: "codex", primary: { usedPercent: 1 } };

    expect(
      selectCodexRateLimit({
        rateLimits: topLevel,
        rateLimitsByLimitId: {
          codex_alpha: firstPrefix,
          codex_beta: { limitId: "codex_beta", primary: { usedPercent: 30 } },
          codex: exact,
        },
      })?.limitId,
    ).toBe("codex");
    expect(
      selectCodexRateLimit({
        rateLimits: topLevel,
        rateLimitsByLimitId: {
          other: { primary: { usedPercent: 90 } },
          codex_missing: undefined,
          codex_alpha: firstPrefix,
          codex_beta: { primary: { usedPercent: 30 } },
        },
      })?.limitId,
    ).toBe("codex_alpha");
    expect(selectCodexRateLimit({ rateLimits: topLevel })?.limitId).toBe("top");
    expect(selectCodexRateLimit({})).toBeNull();
  });
});

describe("OpenAI rate-limit formatting", () => {
  it("formats the exact compact five-hour and weekly status", () => {
    expect(
      formatOpenAiRateLimitStatus(
        {
          primary: { usedPercent: 1, resetsAt: nowEpochSeconds + 7_200 },
          secondary: { usedPercent: 8, resetsAt: nowEpochSeconds + 432_000 },
        },
        now,
      ),
    ).toBe("OpenAI 5h 99% ↺2h | wk 92% ↺5d");
  });

  it("labels a weekly-only primary window from its reported duration", () => {
    expect(
      formatOpenAiRateLimitStatus(
        {
          primary: {
            usedPercent: 8,
            windowDurationMins: 10_080,
            resetsAt: nowEpochSeconds + 432_000,
          },
          secondary: null,
        },
        now,
      ),
    ).toBe("OpenAI wk 92% ↺5d");
  });

  it("labels a five-hour secondary window from its reported duration", () => {
    expect(
      formatOpenAiRateLimitStatus(
        {
          primary: null,
          secondary: { usedPercent: 25, windowDurationMins: 5 * 60 },
        },
        now,
      ),
    ).toBe("OpenAI 5h 75%");
  });

  it("retains positional labels for unrecognized reported durations", () => {
    expect(
      formatOpenAiRateLimitStatus(
        {
          primary: { usedPercent: 25, windowDurationMins: 10_079 },
          secondary: { usedPercent: 50, windowDurationMins: 301 },
        },
        now,
      ),
    ).toBe("OpenAI 5h 75% | wk 50%");
  });

  it("rounds and clamps remaining percentages", () => {
    expect(
      formatOpenAiRateLimitStatus(
        {
          primary: { usedPercent: -0.6 },
          secondary: { usedPercent: 100.6 },
        },
        now,
      ),
    ).toBe("OpenAI 5h 100% | wk 0%");
  });

  it("formats reset boundaries as now, minutes, hours/minutes, and days/hours", () => {
    const status = (seconds: number): string =>
      formatOpenAiRateLimitStatus(
        {
          primary: {
            usedPercent: 0,
            resetsAt: nowEpochSeconds + seconds,
          },
        },
        now,
      );

    expect(status(0)).toBe("OpenAI 5h 100% ↺now");
    expect(status(59)).toBe("OpenAI 5h 100% ↺now");
    expect(status(60)).toBe("OpenAI 5h 100% ↺1m");
    expect(status(75 * 60)).toBe("OpenAI 5h 100% ↺1h15m");
    expect(status(24 * 60 * 60)).toBe("OpenAI 5h 100% ↺1d");
    expect(status(2 * 24 * 60 * 60 + 3 * 60 * 60)).toBe("OpenAI 5h 100% ↺2d3h");
    expect(status(-60)).toBe("OpenAI 5h 100% ↺now");
  });

  it("omits null reset fields and reports an unusable direct snapshot", () => {
    expect(
      formatOpenAiRateLimitStatus(
        { primary: { usedPercent: 25, resetsAt: null }, secondary: null },
        now,
      ),
    ).toBe("OpenAI 5h 75%");
    expect(formatOpenAiRateLimitStatus({}, now)).toBe(
      "OpenAI limits unavailable",
    );
  });

  it.effect("accepts a usable top-level decoded response", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeRateLimitsJsonRpcLine(
        rateLimitsLine(usableResponse()),
      );
      expect(Option.isSome(decoded)).toBe(true);
    }),
  );
});
