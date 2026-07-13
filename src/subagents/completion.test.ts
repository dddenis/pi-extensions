import { describe, it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { expect } from "vitest";
import { FileSystemServiceTest } from "../../test/services/file-system";
import { FileSystemError } from "../services/file-system";
import { completeSubagent } from "./completion";

const regularFile = {
  kind: "file" as const,
  mtimeMs: 0,
  mode: 0o600,
};

const directory = {
  kind: "directory" as const,
  mtimeMs: 0,
  mode: 0o700,
};

const run = (input: unknown) =>
  completeSubagent(input).pipe(Effect.provide(FileSystemServiceTest.layer()));

describe("completeSubagent", () => {
  for (const status of [
    "DONE",
    "DONE_WITH_CONCERNS",
    "NEEDS_CONTEXT",
    "BLOCKED",
  ] as const) {
    it.effect(`accepts semantic status ${status}`, () =>
      Effect.gen(function* () {
        const result = yield* run({ status, summary: "  Completed work  " });

        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: `Subagent completion recorded: ${status}`,
            },
          ],
          details: { status, summary: "Completed work" },
          terminate: true,
        });
      }),
    );
  }

  it.effect("accepts a 500-character single-line summary", () =>
    Effect.gen(function* () {
      const summary = "x".repeat(500);
      expect((yield* run({ status: "DONE", summary })).details.summary).toBe(
        summary,
      );
    }),
  );

  it.effect("rejects a 501-character summary", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        run({ status: "DONE", summary: "x".repeat(501) }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("CompletionValidationError");
      }
    }),
  );

  it.effect("rejects multiline summaries", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        run({ status: "DONE", summary: "first\nsecond" }),
      );
      expect(Either.isLeft(result)).toBe(true);
    }),
  );

  it.effect("rejects a relative report path", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        run({ status: "DONE", summary: "Complete", reportPath: "report.md" }),
      );
      expect(Either.isLeft(result)).toBe(true);
    }),
  );

  it.effect("rejects a missing report", () =>
    completeSubagent({
      status: "DONE",
      summary: "Complete",
      reportPath: "/tmp/missing.md",
    }).pipe(
      Effect.provide(
        FileSystemServiceTest.layer({
          failures: new Map([
            [
              "stat",
              new Map([
                [
                  "/tmp/missing.md",
                  new FileSystemError({
                    operation: "stat",
                    path: "/tmp/missing.md",
                    message: "ENOENT",
                  }),
                ],
              ]),
            ],
          ]),
        }),
      ),
      Effect.either,
      Effect.map((result) => {
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toMatchObject({
            _tag: "CompletionValidationError",
            reportPath: "/tmp/missing.md",
          });
        }
      }),
    ),
  );

  it.effect("rejects a report directory", () =>
    completeSubagent({
      status: "DONE",
      summary: "Complete",
      reportPath: "/tmp/report",
    }).pipe(
      Effect.provide(
        FileSystemServiceTest.layer({
          metadata: new Map([["/tmp/report", directory]]),
        }),
      ),
      Effect.either,
      Effect.map((result) => {
        expect(Either.isLeft(result)).toBe(true);
      }),
    ),
  );

  it.effect(
    "accepts an existing regular absolute report and stores its canonical path",
    () =>
      completeSubagent({
        status: "DONE",
        summary: "  Implemented parser  ",
        reportPath: "/tmp/link-report.md",
      }).pipe(
        Effect.provide(
          FileSystemServiceTest.layer({
            metadata: new Map([["/tmp/link-report.md", regularFile]]),
            realPaths: new Map([["/tmp/link-report.md", "/tmp/report.md"]]),
          }),
        ),
        Effect.map((result) => {
          expect(result).toEqual({
            content: [
              { type: "text", text: "Subagent completion recorded: DONE" },
            ],
            details: {
              status: "DONE",
              summary: "Implemented parser",
              reportPath: "/tmp/report.md",
            },
            terminate: true,
          });
        }),
      ),
  );
});
