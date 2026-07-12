import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { FileSystemError, FileSystemService } from "./file-system";

const withTemporaryDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "pi-extensions-fs-"))),
    use,
    (directory) => Effect.promise(() => rm(directory, { recursive: true })),
  );

describe("FileSystemService", () => {
  it.effect("returns false when a path is missing", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;

        expect(yield* fileSystem.exists(join(directory, "missing"))).toBe(
          false,
        );
      }),
    ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect("reads metadata and UTF-8 content", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "pi-extensions-fs-"))),
      (directory) =>
        Effect.gen(function* () {
          const filePath = join(directory, "session.jsonl");
          yield* Effect.promise(() => writeFile(filePath, "héllo\n", "utf8"));
          const fileSystem = yield* FileSystemService;
          expect(yield* fileSystem.exists(filePath)).toBe(true);
          expect(yield* fileSystem.statMtimeMs(filePath)).toBeGreaterThan(0);
          expect(yield* fileSystem.readTextFile(filePath)).toBe("héllo\n");
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true })),
    ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect("wraps non-ENOENT failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const invalidPath = "\0";

      const error = yield* Effect.flip(fileSystem.exists(invalidPath));

      expect(error).toBeInstanceOf(FileSystemError);
      expect(error.operation).toBe("exists");
      expect(error.path).toBe(invalidPath);
      expect(error.message.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(FileSystemService.Live)),
  );
});
