import { describe, it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { expect } from "vitest";
import { makePiEventAccumulator } from "./pi-events";

const line = (value: unknown): string => JSON.stringify(value);

const usage = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number,
) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const assistantEnd = (options?: {
  readonly calls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
  }>;
  readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  readonly errorMessage?: string;
  readonly usage?: ReturnType<typeof usage>;
}) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: (options?.calls ?? []).map((call) => ({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: {},
    })),
    usage: options?.usage ?? usage(1, 2, 3, 4, 0.5),
    stopReason: options?.stopReason ?? "toolUse",
    ...(options?.errorMessage === undefined
      ? {}
      : { errorMessage: options.errorMessage }),
  },
});

const assistantMessage = (options?: {
  readonly content?: ReadonlyArray<unknown>;
  readonly usage?: ReturnType<typeof usage>;
  readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  readonly errorMessage?: string;
}) => ({
  role: "assistant",
  content: options?.content ?? [],
  api: "test-api",
  provider: "test-provider",
  model: "test-model",
  usage: options?.usage ?? usage(1, 2, 3, 4, 0.5),
  stopReason: options?.stopReason ?? "stop",
  timestamp: 0,
  ...(options?.errorMessage === undefined
    ? {}
    : { errorMessage: options.errorMessage }),
});

const messageUpdate = (assistantMessageEvent: unknown) => ({
  type: "message_update",
  message: assistantMessage(),
  assistantMessageEvent,
});

const completionEnd = (
  toolCallId = "completion-1",
  options?: { readonly isError?: boolean; readonly summary?: string },
) => ({
  type: "tool_execution_end",
  toolCallId,
  toolName: "complete_subagent",
  result: {
    content: [{ type: "text", text: "Subagent completion recorded: DONE" }],
    details: {
      status: "DONE",
      summary: options?.summary ?? "Implemented parser",
      reportPath: "/tmp/report.md",
    },
    terminate: true,
  },
  isError: options?.isError ?? false,
});

const validCompletion = (id = "completion-1") => [
  assistantEnd({ calls: [{ id, name: "complete_subagent" }] }),
  {
    type: "tool_execution_start",
    toolCallId: id,
    toolName: "complete_subagent",
    args: { status: "DONE" },
  },
  completionEnd(id),
  { type: "agent_settled" },
];

const consumeAll = (
  accumulator: ReturnType<typeof makePiEventAccumulator>,
  values: ReadonlyArray<unknown>,
) =>
  Effect.forEach(values, (value) => accumulator.consume(line(value)), {
    discard: true,
  });

describe("PiEventAccumulator", () => {
  it.effect(
    "decodes Pi session, text-delta, tool-start, and unknown JSON events",
    () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();

        expect(
          yield* accumulator.consume(
            line({
              type: "session",
              version: 3,
              id: "session-1",
              timestamp: "2026-07-12T00:00:00.000Z",
              cwd: "/repo",
            }),
          ),
        ).toEqual({ type: "session", sessionId: "session-1" });
        expect(
          yield* accumulator.consume(
            line(
              messageUpdate({
                type: "text_delta",
                contentIndex: 0,
                delta: "Working",
                partial: assistantMessage(),
              }),
            ),
          ),
        ).toEqual({ type: "assistant", text: "Working" });
        const toolEvent = yield* accumulator.consume(
          line({
            type: "tool_execution_start",
            toolCallId: "read-1",
            toolName: "read",
            args: {
              path: "/private/customer.txt",
              token: "short-secret-token",
              command: "publish private prompt",
            },
          }),
        );
        expect(toolEvent).toEqual({
          type: "tool",
          name: "read",
          preview: "started",
        });
        expect(JSON.stringify(toolEvent)).not.toContain("short-secret-token");
        expect(JSON.stringify(toolEvent)).not.toContain(
          "/private/customer.txt",
        );
        expect(JSON.stringify(toolEvent)).not.toContain("private prompt");
        expect(
          yield* accumulator.consume(
            line({ type: "future_event", secret: true }),
          ),
        ).toEqual({ type: "ignored" });
        expect(yield* accumulator.consume(line(["valid", "json"]))).toEqual({
          type: "ignored",
        });
      }),
  );

  it.effect("rejects malformed non-empty JSON with line context", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      yield* accumulator.consume("  ");
      const result = yield* Effect.either(accumulator.consume("{not-json"));

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toMatchObject({
          _tag: "PiEventStreamError",
          lineNumber: 2,
          rawLine: "{not-json",
        });
      }
    }),
  );

  it.effect("rejects recognized malformed message_update variants", () =>
    Effect.gen(function* () {
      const malformedUpdates = [
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "missing message",
            partial: assistantMessage(),
          },
        },
        {
          type: "message_update",
          message: assistantMessage(),
          assistantMessageEvent: {
            type: "text_delta",
            delta: "missing content index",
            partial: assistantMessage(),
          },
        },
        {
          type: "message_update",
          message: assistantMessage(),
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "missing partial",
          },
        },
      ];

      for (const malformed of malformedUpdates) {
        const accumulator = makePiEventAccumulator();
        const result = yield* Effect.either(
          accumulator.consume(line(malformed)),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left._tag).toBe("PiEventStreamError");
        }
        yield* accumulator.consume(line({ type: "agent_settled" }));
        expect(
          (yield* accumulator.finalize({ code: 0, signal: null })).status,
        ).toBe("failed");
      }
    }),
  );

  it.effect("decodes every known AssistantMessageEvent variant", () =>
    Effect.gen(function* () {
      const partial = assistantMessage();
      const textPartial = assistantMessage({
        content: [{ type: "text", text: "text" }],
      });
      const thinkingPartial = assistantMessage({
        content: [{ type: "thinking", thinking: "thought" }],
      });
      const toolCall = {
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path: "/repo/file.ts" },
      };
      const toolPartial = assistantMessage({ content: [toolCall] });
      const knownEvents: ReadonlyArray<unknown> = [
        { type: "start", partial: textPartial },
        { type: "text_start", contentIndex: 0, partial: thinkingPartial },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: "text",
          partial: toolPartial,
        },
        {
          type: "text_end",
          contentIndex: 0,
          content: "text",
          partial,
        },
        { type: "thinking_start", contentIndex: 0, partial },
        {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "thought",
          partial,
        },
        {
          type: "thinking_end",
          contentIndex: 0,
          content: "thought",
          partial,
        },
        { type: "toolcall_start", contentIndex: 0, partial },
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"path":',
          partial,
        },
        { type: "toolcall_end", contentIndex: 0, toolCall, partial },
        {
          type: "done",
          reason: "stop",
          message: assistantMessage({ stopReason: "stop" }),
        },
        {
          type: "error",
          reason: "error",
          error: assistantMessage({
            stopReason: "error",
            errorMessage: "provider failed",
          }),
        },
      ];

      for (const knownEvent of knownEvents) {
        const accumulator = makePiEventAccumulator();
        const result = yield* Effect.either(
          accumulator.consume(line(messageUpdate(knownEvent))),
        );
        expect(Either.isRight(result)).toBe(true);
      }
    }),
  );

  it.effect(
    "ignores a genuinely unknown future AssistantMessageEvent subtype",
    () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();
        expect(
          yield* accumulator.consume(
            line(messageUpdate({ type: "future_assistant_event" })),
          ),
        ).toEqual({ type: "ignored" });
        yield* consumeAll(accumulator, validCompletion());
        expect(
          (yield* accumulator.finalize({ code: 0, signal: null })).status,
        ).toBe("completed");
      }),
  );

  it.effect(
    "rejects every malformed known AssistantMessageEvent variant permanently",
    () =>
      Effect.gen(function* () {
        const malformedKnownEvents: ReadonlyArray<unknown> = [
          { type: "start" },
          { type: "text_start", contentIndex: 0 },
          { type: "text_delta", contentIndex: 0, delta: "text" },
          {
            type: "text_end",
            contentIndex: 0,
            partial: assistantMessage(),
          },
          { type: "thinking_start", contentIndex: 0 },
          { type: "thinking_delta", delta: "malformed thought" },
          {
            type: "thinking_end",
            contentIndex: 0,
            partial: assistantMessage(),
          },
          { type: "toolcall_start", contentIndex: 0 },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            partial: assistantMessage(),
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: { type: "toolCall", id: "read-1", name: "read" },
            partial: assistantMessage(),
          },
          { type: "done", reason: "stop" },
          { type: "error", reason: "error" },
        ];

        for (const malformedKnownEvent of malformedKnownEvents) {
          const accumulator = makePiEventAccumulator();
          const malformed = yield* Effect.either(
            accumulator.consume(line(messageUpdate(malformedKnownEvent))),
          );
          expect(Either.isLeft(malformed)).toBe(true);
          if (Either.isLeft(malformed)) {
            expect(malformed.left._tag).toBe("PiEventStreamError");
          }

          yield* consumeAll(accumulator, validCompletion());
          expect(
            (yield* accumulator.finalize({ code: 0, signal: null })).status,
          ).toBe("failed");
        }
      }),
  );

  it.effect(
    "rejects malformed nested AssistantMessage values permanently",
    () =>
      Effect.gen(function* () {
        const valid = assistantMessage();
        const malformedNestedUpdates: ReadonlyArray<unknown> = [
          {
            ...messageUpdate({ type: "start", partial: valid }),
            message: {},
          },
          messageUpdate({ type: "start", partial: {} }),
          messageUpdate({ type: "start", partial: { ...valid, role: "user" } }),
          messageUpdate({
            type: "start",
            partial: { ...valid, content: [{}] },
          }),
          messageUpdate({
            type: "start",
            partial: {
              ...valid,
              content: [{ type: "text" }],
            },
          }),
          messageUpdate({
            type: "start",
            partial: {
              ...valid,
              content: [{ type: "thinking" }],
            },
          }),
          messageUpdate({
            type: "start",
            partial: {
              ...valid,
              content: [{ type: "toolCall", id: "read-1", name: "read" }],
            },
          }),
          messageUpdate({ type: "start", partial: { ...valid, api: 1 } }),
          messageUpdate({ type: "start", partial: { ...valid, provider: 1 } }),
          messageUpdate({ type: "start", partial: { ...valid, model: 1 } }),
          messageUpdate({
            type: "start",
            partial: {
              ...valid,
              usage: { ...valid.usage, totalTokens: "invalid" },
            },
          }),
          messageUpdate({
            type: "start",
            partial: {
              ...valid,
              usage: {
                ...valid.usage,
                cost: { ...valid.usage.cost, total: "invalid" },
              },
            },
          }),
          messageUpdate({
            type: "start",
            partial: { ...valid, stopReason: "future" },
          }),
          messageUpdate({
            type: "start",
            partial: { ...valid, timestamp: "now" },
          }),
          messageUpdate({
            type: "done",
            reason: "stop",
            message: assistantMessage({
              stopReason: "error",
              errorMessage: "wrong terminal message",
            }),
          }),
          messageUpdate({
            type: "error",
            reason: "error",
            error: assistantMessage({ stopReason: "error" }),
          }),
        ];

        for (const malformedNestedUpdate of malformedNestedUpdates) {
          const accumulator = makePiEventAccumulator();
          const malformed = yield* Effect.either(
            accumulator.consume(line(malformedNestedUpdate)),
          );
          expect(Either.isLeft(malformed)).toBe(true);
          if (Either.isLeft(malformed)) {
            expect(malformed.left._tag).toBe("PiEventStreamError");
          }

          yield* consumeAll(accumulator, validCompletion());
          expect(
            (yield* accumulator.finalize({ code: 0, signal: null })).status,
          ).toBe("failed");
        }
      }),
  );

  it.effect("rejects a completion tool call without arguments", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      const result = yield* Effect.either(
        accumulator.consume(
          line({
            ...assistantEnd(),
            message: {
              ...assistantEnd().message,
              content: [
                {
                  type: "toolCall",
                  id: "completion-1",
                  name: "complete_subagent",
                },
              ],
            },
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("PiEventStreamError");
      }
      yield* accumulator.consume(line({ type: "agent_settled" }));
      expect(
        (yield* accumulator.finalize({ code: 0, signal: null })).status,
      ).toBe("failed");
    }),
  );

  it.effect("rejects malformed exact completion tool results", () =>
    Effect.gen(function* () {
      const validDetails = {
        status: "DONE",
        summary: "Implemented parser",
        reportPath: "/tmp/report.md",
      };
      const invalidResults: ReadonlyArray<unknown> = [
        { content: [], details: validDetails, terminate: true },
        {
          content: [
            { type: "text", text: "Subagent completion recorded: BLOCKED" },
          ],
          details: validDetails,
          terminate: true,
        },
        {
          content: [
            { type: "text", text: "Subagent completion recorded: DONE" },
          ],
          details: { ...validDetails, unexpected: true },
          terminate: true,
        },
        {
          content: [
            {
              type: "text",
              text: "Subagent completion recorded: DONE",
              unexpected: true,
            },
          ],
          details: validDetails,
          terminate: true,
        },
        {
          content: [
            { type: "text", text: "Subagent completion recorded: DONE" },
          ],
          details: validDetails,
          terminate: true,
          unexpected: true,
        },
      ];

      for (const invalidResult of invalidResults) {
        const accumulator = makePiEventAccumulator();
        yield* accumulator.consume(
          line(
            assistantEnd({
              calls: [{ id: "completion-1", name: "complete_subagent" }],
            }),
          ),
        );
        const result = yield* Effect.either(
          accumulator.consume(
            line({ ...completionEnd(), result: invalidResult }),
          ),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left._tag).toBe("PiEventStreamError");
        }
        yield* accumulator.consume(line({ type: "agent_settled" }));
        expect(
          (yield* accumulator.finalize({ code: 0, signal: null })).status,
        ).toBe("failed");
      }
    }),
  );

  it.effect("rejects non-integer token usage", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      const result = yield* Effect.either(
        accumulator.consume(
          line(
            assistantEnd({
              calls: [],
              stopReason: "stop",
              usage: usage(1.5, 2, 3, 4, 0.5),
            }),
          ),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
    }),
  );

  it.effect("aggregates usage only at assistant message_end", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      const streamingMessage = assistantMessage({
        usage: usage(100, 100, 100, 100, 100),
      });
      yield* accumulator.consume(
        line({
          ...messageUpdate({
            type: "text_delta",
            contentIndex: 0,
            delta: "partial",
            partial: streamingMessage,
          }),
          message: streamingMessage,
        }),
      );
      expect(
        yield* accumulator.consume(
          line(
            assistantEnd({
              calls: [],
              stopReason: "stop",
              usage: usage(2, 3, 5, 7, 1.25),
            }),
          ),
        ),
      ).toEqual({
        type: "usage",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 5,
          cacheWrite: 7,
          cost: 1.25,
          turns: 1,
        },
      });
      yield* accumulator.consume(
        line(
          assistantEnd({
            calls: [],
            stopReason: "stop",
            usage: usage(11, 13, 17, 19, 2.5),
          }),
        ),
      );

      expect((yield* accumulator.snapshot).usage).toEqual({
        input: 13,
        output: 16,
        cacheRead: 22,
        cacheWrite: 26,
        cost: 3.75,
        turns: 2,
      });
    }),
  );

  it.effect(
    "finalizes one correlated successful completion after settlement",
    () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();
        yield* accumulator.consume(line({ type: "session", id: "session-1" }));
        yield* consumeAll(accumulator, validCompletion());

        expect(yield* accumulator.snapshot).toMatchObject({
          sessionId: "session-1",
          settled: true,
          completion: {
            status: "DONE",
            summary: "Implemented parser",
            reportPath: "/tmp/report.md",
          },
        });
        expect(yield* accumulator.finalize({ code: 0, signal: null })).toEqual({
          status: "completed",
          sessionId: "session-1",
          completion: {
            status: "DONE",
            summary: "Implemented parser",
            reportPath: "/tmp/report.md",
          },
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            cost: 0.5,
            turns: 1,
          },
        });
      }),
  );

  it.effect(
    "requires exactly one completion call in the correlated assistant message",
    () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();
        yield* consumeAll(accumulator, [
          assistantEnd({
            calls: [
              { id: "completion-1", name: "complete_subagent" },
              { id: "completion-2", name: "complete_subagent" },
            ],
          }),
          completionEnd("completion-1"),
          { type: "agent_settled" },
        ]);

        expect(
          (yield* accumulator.finalize({ code: 0, signal: null })).status,
        ).toBe("failed");
      }),
  );

  it.effect(
    "rejects completion when any other tool call shares its assistant message",
    () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();
        yield* consumeAll(accumulator, [
          assistantEnd({
            calls: [
              { id: "completion-1", name: "complete_subagent" },
              { id: "read-1", name: "read" },
            ],
          }),
          completionEnd("completion-1"),
          { type: "agent_settled" },
        ]);

        expect(
          (yield* accumulator.finalize({ code: 0, signal: null })).status,
        ).toBe("failed");
      }),
  );

  it.effect("requires the successful result to correlate by tool call id", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      yield* consumeAll(accumulator, [
        assistantEnd({
          calls: [{ id: "completion-1", name: "complete_subagent" }],
        }),
        completionEnd("different-id"),
        { type: "agent_settled" },
      ]);

      expect(
        (yield* accumulator.finalize({ code: 0, signal: null })).status,
      ).toBe("failed");
    }),
  );

  it.effect("rejects an errored completion tool result", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      yield* consumeAll(accumulator, [
        assistantEnd({
          calls: [{ id: "completion-1", name: "complete_subagent" }],
        }),
        completionEnd("completion-1", { isError: true }),
        { type: "agent_settled" },
      ]);

      expect(
        (yield* accumulator.finalize({ code: 0, signal: null })).status,
      ).toBe("failed");
    }),
  );

  it.effect(
    "invalidates completion permanently when later assistant work occurs",
    () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();
        yield* consumeAll(accumulator, [
          ...validCompletion().slice(0, -1),
          messageUpdate({
            type: "text_delta",
            contentIndex: 0,
            delta: "more work",
            partial: assistantMessage(),
          }),
          ...validCompletion("completion-2"),
        ]);

        const final = yield* accumulator.finalize({ code: 0, signal: null });
        expect(final.status).toBe("failed");
        if (final.status === "failed") {
          expect(final.reason).toContain("invalidated");
        }
      }),
  );

  it.effect("invalidates completion on later non-text assistant updates", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      yield* consumeAll(accumulator, [
        ...validCompletion().slice(0, -1),
        messageUpdate({
          type: "thinking_delta",
          contentIndex: 0,
          delta: "continued reasoning",
          partial: assistantMessage(),
        }),
        { type: "agent_settled" },
      ]);

      expect((yield* accumulator.snapshot).completionInvalidated).toBe(true);
    }),
  );

  it.effect("invalidates completion on a later assistant message start", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      yield* consumeAll(accumulator, [
        ...validCompletion().slice(0, -1),
        { type: "message_start", message: { role: "assistant" } },
        { type: "agent_settled" },
      ]);

      expect((yield* accumulator.snapshot).completionInvalidated).toBe(true);
    }),
  );

  it.effect("invalidates completion on a later tool update", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      yield* consumeAll(accumulator, [
        ...validCompletion().slice(0, -1),
        {
          type: "tool_execution_update",
          toolCallId: "read-1",
          toolName: "read",
          args: {},
          partialResult: { content: "later work" },
        },
        { type: "agent_settled" },
      ]);

      expect((yield* accumulator.snapshot).completionInvalidated).toBe(true);
    }),
  );

  it.effect(
    "invalidates a pending candidate on unrelated later tool work",
    () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();
        yield* consumeAll(accumulator, [
          assistantEnd({
            calls: [{ id: "completion-1", name: "complete_subagent" }],
          }),
          {
            type: "tool_execution_start",
            toolCallId: "read-1",
            toolName: "read",
            args: {},
          },
          completionEnd("completion-1"),
          { type: "agent_settled" },
        ]);

        expect((yield* accumulator.snapshot).completionInvalidated).toBe(true);
        expect(
          (yield* accumulator.finalize({ code: 0, signal: null })).status,
        ).toBe("failed");
      }),
  );

  it.effect("requires agent settlement", () =>
    Effect.gen(function* () {
      const accumulator = makePiEventAccumulator();
      yield* consumeAll(accumulator, validCompletion().slice(0, -1));
      const final = yield* accumulator.finalize({ code: 0, signal: null });

      expect(final).toMatchObject({
        status: "failed",
        reason: "Pi event stream did not settle",
      });
    }),
  );

  for (const stopReason of ["error", "aborted"] as const) {
    it.effect(`fails on provider ${stopReason} with exit code zero`, () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();
        yield* accumulator.consume(
          line(
            assistantEnd({
              calls: [],
              stopReason,
              errorMessage: `provider ${stopReason}`,
            }),
          ),
        );
        yield* accumulator.consume(line({ type: "agent_settled" }));

        expect(
          yield* accumulator.finalize({ code: 0, signal: null }),
        ).toMatchObject({
          status: "failed",
          reason: `provider ${stopReason}`,
        });
      }),
    );
  }

  it.effect(
    "fails a completed stream when the process exit is unsuccessful",
    () =>
      Effect.gen(function* () {
        const accumulator = makePiEventAccumulator();
        yield* consumeAll(accumulator, validCompletion());

        expect(
          yield* accumulator.finalize({ code: 9, signal: null }),
        ).toMatchObject({ status: "failed" });
        expect(
          yield* accumulator.finalize({ code: null, signal: "SIGTERM" }),
        ).toMatchObject({ status: "failed" });
      }),
  );
});
