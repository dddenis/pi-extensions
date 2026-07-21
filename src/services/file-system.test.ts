import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

  it.effect("publishes a zero-byte current-user 0600 regular file", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const markerPath = join(directory, "attention");
        const fileSystem = yield* FileSystemService;

        yield* fileSystem.replaceWithPrivateEmptyFile(markerPath);

        const metadata = yield* Effect.promise(() => lstat(markerPath));
        expect(metadata.isFile()).toBe(true);
        expect(metadata.isSymbolicLink()).toBe(false);
        expect(metadata.size).toBe(0);
        expect(metadata.mode & 0o777).toBe(0o600);
        if (process.getuid === undefined) {
          throw new Error("process.getuid is unavailable");
        }
        expect(metadata.uid).toBe(process.getuid());
      }),
    ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect(
    "replaces wrong-mode files and symlinks without touching their targets",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const targetPath = join(directory, "target");
          const markerPath = join(directory, "attention");
          yield* Effect.promise(() => writeFile(targetPath, "keep"));
          yield* Effect.promise(() => writeFile(markerPath, "stale"));
          yield* Effect.promise(() => chmod(markerPath, 0o644));

          yield* fileSystem.replaceWithPrivateEmptyFile(markerPath);
          expect(
            (yield* Effect.promise(() => lstat(markerPath))).mode & 0o777,
          ).toBe(0o600);
          expect(
            yield* Effect.promise(() => readFile(markerPath, "utf8")),
          ).toBe("");

          yield* fileSystem.removeFile(markerPath);
          yield* Effect.promise(() => symlink(targetPath, markerPath));
          yield* fileSystem.replaceWithPrivateEmptyFile(markerPath);

          expect(
            (yield* Effect.promise(() => lstat(markerPath))).isFile(),
          ).toBe(true);
          expect(
            yield* Effect.promise(() => readFile(targetPath, "utf8")),
          ).toBe("keep");
        }),
      ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect(
    "rejects a directory target and cleans its unpublished sibling",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const markerPath = join(directory, "attention");
          yield* Effect.promise(() => mkdir(markerPath));

          const error = yield* Effect.flip(
            fileSystem.replaceWithPrivateEmptyFile(markerPath),
          );

          expect(error).toMatchObject({
            operation: "replaceWithPrivateEmptyFile",
            path: markerPath,
          });
          expect(yield* Effect.promise(() => readdir(directory))).toEqual([
            "attention",
          ]);
        }),
      ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect(
    "removes the named entry without following symlinks and ignores absence",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const targetPath = join(directory, "target");
          const markerPath = join(directory, "attention");
          yield* Effect.promise(() => writeFile(targetPath, "keep"));
          yield* Effect.promise(() => symlink(targetPath, markerPath));

          yield* fileSystem.removeFile(markerPath);
          yield* fileSystem.removeFile(markerPath);

          expect(
            yield* Effect.promise(() => readFile(targetPath, "utf8")),
          ).toBe("keep");
          expect(yield* Effect.promise(() => readdir(directory))).toEqual([
            "target",
          ]);
        }),
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
