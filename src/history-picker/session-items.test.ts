import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { expect } from "vitest";
import {
  indexCurrentSessionEntries,
  parseSavedSessionJsonl,
} from "./session-items";

const currentUserEntry = (
  id: string,
  content:
    | string
    | ReadonlyArray<
        | { readonly type: "text"; readonly text: string }
        | {
            readonly type: "image";
            readonly data: string;
            readonly mimeType: string;
          }
      >,
  messageTimestamp: number,
  entryTimestamp: string,
  parentId: string | null = null,
): SessionEntry => {
  const messageContent =
    typeof content === "string"
      ? content
      : content.map((block) => ({ ...block }));

  return {
    type: "message",
    id,
    parentId,
    timestamp: entryTimestamp,
    message: {
      role: "user",
      content: messageContent,
      timestamp: messageTimestamp,
    },
  };
};

const savedMessage = (
  id: string,
  message: unknown,
  timestamp = "2026-01-02T03:04:05.000Z",
): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp,
    message,
  });

const parse = (
  jsonl: string,
  sessionFile = "/sessions/example.jsonl",
  listingCwd = "/listing/project",
) => parseSavedSessionJsonl(jsonl, sessionFile, listingCwd);

describe("session history projection", () => {
  it("indexes string and mixed text/image current user entries from every branch", () => {
    const entries: ReadonlyArray<SessionEntry> = [
      currentUserEntry("root0001", "root prompt", 10, "2026-01-01T00:00:00Z"),
      currentUserEntry(
        "branch01",
        [
          { type: "text", text: "look " },
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "text", text: "here" },
        ],
        20,
        "2026-01-01T00:00:01Z",
        "root0001",
      ),
      currentUserEntry(
        "branch02",
        "abandoned branch prompt",
        15,
        "2026-01-01T00:00:02Z",
        "root0001",
      ),
      {
        type: "model_change",
        id: "model001",
        parentId: "root0001",
        timestamp: "2026-01-01T00:00:03Z",
        provider: "example",
        modelId: "model",
      },
    ];

    expect(
      indexCurrentSessionEntries(
        entries,
        "/sessions/current.jsonl",
        "/project",
      ),
    ).toEqual([
      {
        text: "root prompt",
        timestamp: 10,
        sessionFile: "/sessions/current.jsonl",
        cwd: "/project",
        source: "current",
      },
      {
        text: "look here",
        timestamp: 20,
        sessionFile: "/sessions/current.jsonl",
        cwd: "/project",
        source: "current",
      },
      {
        text: "abandoned branch prompt",
        timestamp: 15,
        sessionFile: "/sessions/current.jsonl",
        cwd: "/project",
        source: "current",
      },
    ]);
  });

  it.effect(
    "decodes saved strings and blocks, ignores valid irrelevant and empty entries",
    () =>
      Effect.gen(function* () {
        const jsonl = [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "session-id",
            timestamp: "2026-01-01T00:00:00Z",
            cwd: "/header/project",
          }),
          savedMessage("msg00001", {
            role: "user",
            content: "plain",
            timestamp: 100,
          }),
          savedMessage("msg00002", {
            role: "user",
            content: [
              { type: "image", data: "abc", mimeType: "image/png" },
              { type: "text", text: "mixed" },
              { type: "image", data: "def", mimeType: "image/jpeg" },
              { type: "text", text: " blocks" },
            ],
            timestamp: 200,
          }),
          savedMessage("msg00003", {
            role: "user",
            content: [],
            timestamp: 300,
          }),
          savedMessage("msg00004", {
            role: "user",
            content: "",
            timestamp: 350,
          }),
          savedMessage("msg00005", {
            role: "assistant",
            content: [],
            api: "example-api",
            provider: "example-provider",
            model: "example-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 400,
          }),
          JSON.stringify({
            type: "custom",
            id: "custom01",
            parentId: "msg00005",
            timestamp: "2026-01-02T03:04:06.000Z",
            customType: "ignored",
            data: {},
          }),
        ].join("\n");

        expect(yield* parse(jsonl)).toEqual([
          {
            text: "plain",
            timestamp: 100,
            sessionFile: "/sessions/example.jsonl",
            cwd: "/header/project",
            source: "saved",
          },
          {
            text: "mixed blocks",
            timestamp: 200,
            sessionFile: "/sessions/example.jsonl",
            cwd: "/header/project",
            source: "saved",
          },
        ]);
      }),
  );

  it.effect("uses numeric message time, then ISO entry time, then zero", () =>
    Effect.gen(function* () {
      const iso = "2026-01-02T03:04:05.000Z";
      const jsonl = [
        savedMessage(
          "msg00001",
          { role: "user", content: "message time", timestamp: 123 },
          "2020-01-01T00:00:00Z",
        ),
        savedMessage("msg00002", { role: "user", content: "entry time" }, iso),
        savedMessage(
          "msg00003",
          { role: "user", content: "zero time" },
          "not-an-iso-date",
        ),
      ].join("\n");

      const items = yield* parse(jsonl);
      expect(items.map((item) => item.timestamp)).toEqual([
        123,
        Date.parse(iso),
        0,
      ]);
      expect(items.every((item) => item.cwd === "/listing/project")).toBe(true);
    }),
  );

  it.effect("uses the saved header cwd and supports CRLF input", () =>
    Effect.gen(function* () {
      const jsonl = [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-id",
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/header/project",
        }),
        "",
        savedMessage("msg00001", {
          role: "user",
          content: "hello",
          timestamp: 1,
        }),
      ].join("\r\n");

      expect((yield* parse(jsonl))[0]?.cwd).toBe("/header/project");
    }),
  );

  it.effect(
    "reports malformed JSON at its physical file line after blanks",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.either(
          parse(
            [
              JSON.stringify({
                type: "session",
                version: 3,
                id: "session-id",
                timestamp: "2026-01-01T00:00:00Z",
                cwd: "/project",
              }),
              "",
              "   ",
              "{broken",
            ].join("\n"),
            "/sessions/bad.jsonl",
          ),
        );

        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toMatchObject({
            _tag: "MalformedSessionJsonlError",
            sessionFile: "/sessions/bad.jsonl",
            lineNumber: 4,
          });
        }
      }),
  );

  it.effect("rejects unknown message roles at the exact physical line", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        parse(
          [
            JSON.stringify({ type: "custom", customType: "ignored" }),
            "",
            "   ",
            savedMessage("msg00001", {
              role: "assisstant",
              content: [],
              timestamp: 10,
            }),
          ].join("\n"),
          "/sessions/unknown-role.jsonl",
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toMatchObject({
          _tag: "MalformedSessionJsonlError",
          sessionFile: "/sessions/unknown-role.jsonl",
          lineNumber: 4,
        });
      }
    }),
  );

  it.effect(
    "rejects malformed supported non-user messages at the exact physical line",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.either(
          parse(
            [
              JSON.stringify({ type: "custom", customType: "ignored" }),
              "",
              savedMessage("msg00001", {
                role: "assistant",
                content: [],
                timestamp: 10,
              }),
            ].join("\n"),
            "/sessions/malformed-assistant.jsonl",
          ),
        );

        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toMatchObject({
            _tag: "MalformedSessionJsonlError",
            sessionFile: "/sessions/malformed-assistant.jsonl",
            lineNumber: 3,
          });
        }
      }),
  );

  it.effect("validates and ignores every supported non-user message role", () =>
    Effect.gen(function* () {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "thinking", thinking: "reason" },
            { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          ],
          api: "example-api",
          provider: "example-provider",
          model: "example-model",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 10,
            cost: {
              input: 0.1,
              output: 0.2,
              cacheRead: 0.3,
              cacheWrite: 0.4,
              total: 1,
            },
          },
          stopReason: "toolUse",
          timestamp: 10,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: 11,
        },
        {
          role: "bashExecution",
          command: "pwd",
          output: "/project",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 12,
        },
        {
          role: "custom",
          customType: "extension-message",
          content: [
            { type: "text", text: "context" },
            { type: "image", data: "abc", mimeType: "image/png" },
          ],
          display: true,
          details: { additional: "metadata" },
          timestamp: 13,
        },
        {
          role: "branchSummary",
          summary: "branch summary",
          fromId: "msg00001",
          timestamp: 14,
        },
        {
          role: "compactionSummary",
          summary: "compaction summary",
          tokensBefore: 100,
          timestamp: 15,
        },
      ];
      const jsonl = messages
        .map((message, index) => savedMessage(`msg0000${index}`, message))
        .join("\n");

      expect(yield* parse(jsonl)).toEqual([]);
    }),
  );

  it.effect(
    "rejects malformed message records and malformed user content",
    () =>
      Effect.gen(function* () {
        const malformedRecords = [
          JSON.stringify({ payload: "missing discriminator" }),
          JSON.stringify({ type: "message" }),
          savedMessage("msg00001", { role: "user", content: 42 }),
          savedMessage("msg00002", {
            role: "user",
            content: [{ type: "text" }],
          }),
        ];

        for (const line of malformedRecords) {
          const result = yield* Effect.either(parse(line));
          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result)) {
            expect(result.left).toMatchObject({
              _tag: "MalformedSessionJsonlError",
              lineNumber: 1,
            });
          }
        }
      }),
  );
});
