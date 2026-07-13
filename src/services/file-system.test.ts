import {
  chmod,
  mkdtemp,
  realpath,
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
    Effect.promise(() =>
      mkdtemp(join(tmpdir(), "pi-extensions-fs-")).then((directory) =>
        realpath(directory, "utf8"),
      ),
    ),
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

  it.effect(
    "creates private files, appends content, renames them, and reports metadata",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const runDirectory = join(directory, "run");
          const source = join(runDirectory, "status.next.json");
          const target = join(runDirectory, "status.json");

          yield* fileSystem.makeDirectory(runDirectory, {
            recursive: true,
            mode: 0o700,
          });
          yield* fileSystem.writeTextFile(source, '{"status":"STARTING"}\n', {
            mode: 0o600,
          });
          yield* fileSystem.appendTextFile(source, "tail\n");
          yield* fileSystem.rename(source, target);

          expect(yield* fileSystem.readTextFile(target)).toBe(
            '{"status":"STARTING"}\ntail\n',
          );
          expect((yield* fileSystem.stat(runDirectory)).kind).toBe("directory");
          expect((yield* fileSystem.stat(target)).kind).toBe("file");
          expect((yield* fileSystem.stat(runDirectory)).mode & 0o777).toBe(
            0o700,
          );
          expect((yield* fileSystem.stat(target)).mode & 0o777).toBe(0o600);
          expect(yield* fileSystem.realPath(target)).toBe(target);

          yield* fileSystem.remove(target);
          expect(yield* fileSystem.exists(target)).toBe(false);
        }),
      ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect("applies the requested mode when replacing an existing file", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const filePath = join(directory, "status.json");
        yield* Effect.promise(() => writeFile(filePath, "public\n", "utf8"));
        if (process.platform !== "win32") {
          yield* Effect.promise(() => chmod(filePath, 0o644));
        }

        const fileSystem = yield* FileSystemService;
        yield* fileSystem.writeTextFile(filePath, "private\n", { mode: 0o600 });

        expect(yield* fileSystem.readTextFile(filePath)).toBe("private\n");
        if (process.platform !== "win32") {
          expect((yield* fileSystem.stat(filePath)).mode & 0o777).toBe(0o600);
        }
      }),
    ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect(
    "reads directory entries with file, directory, and other kinds",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const nestedDirectory = join(directory, "nested");
          const filePath = join(directory, "session.jsonl");
          const linkPath = join(directory, "session-link.jsonl");

          yield* fileSystem.makeDirectory(nestedDirectory, {
            recursive: false,
            mode: 0o700,
          });
          yield* fileSystem.writeTextFile(filePath, "héllo\n", { mode: 0o600 });
          yield* Effect.promise(() => symlink(filePath, linkPath));

          expect(
            [...(yield* fileSystem.readDirectory(directory))].sort(
              (left, right) => left.name.localeCompare(right.name),
            ),
          ).toEqual([
            { name: "nested", kind: "directory" },
            { name: "session-link.jsonl", kind: "other" },
            { name: "session.jsonl", kind: "file" },
          ]);
        }),
      ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect("reads modification time and UTF-8 content", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const filePath = join(directory, "session.jsonl");
        yield* Effect.promise(() => writeFile(filePath, "héllo\n", "utf8"));
        const fileSystem = yield* FileSystemService;

        expect(yield* fileSystem.statMtimeMs(filePath)).toBeGreaterThan(0);
        expect(yield* fileSystem.readTextFile(filePath)).toBe("héllo\n");
      }),
    ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect("wraps missing stat failures", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const missingPath = join(directory, "missing");

        const error = yield* Effect.flip(fileSystem.stat(missingPath));

        expect(error).toBeInstanceOf(FileSystemError);
        expect(error.operation).toBe("stat");
        expect(error.path).toBe(missingPath);
        expect(error.message.length).toBeGreaterThan(0);
      }),
    ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect("wraps non-ENOENT exists failures", () =>
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

  it.effect("reports both paths when rename fails", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const source = join(directory, "missing");
        const target = join(directory, "target");

        const error = yield* Effect.flip(fileSystem.rename(source, target));

        expect(error).toBeInstanceOf(FileSystemError);
        expect(error.operation).toBe("rename");
        expect(error.path).toBe(`${source} -> ${target}`);
      }),
    ).pipe(Effect.provide(FileSystemService.Live)),
  );

  it.effect("requires recursive removal for directories", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const runDirectory = join(directory, "run");
        const nestedFile = join(runDirectory, "status.json");

        yield* fileSystem.makeDirectory(runDirectory, {
          recursive: true,
          mode: 0o700,
        });
        yield* fileSystem.writeTextFile(nestedFile, "{}\n", { mode: 0o600 });

        const error = yield* Effect.flip(fileSystem.remove(runDirectory));

        expect(error).toBeInstanceOf(FileSystemError);
        expect(error.operation).toBe("remove");
        expect(error.path).toBe(runDirectory);

        yield* fileSystem.remove(runDirectory, { recursive: true });
        expect(yield* fileSystem.exists(runDirectory)).toBe(false);
      }),
    ).pipe(Effect.provide(FileSystemService.Live)),
  );
});
