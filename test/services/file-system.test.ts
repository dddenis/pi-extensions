import { win32 } from "node:path";
import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { expect } from "vitest";
import {
  FileSystemError,
  FileSystemService,
} from "../../src/services/file-system";
import { FileSystemServiceTest } from "./file-system";

const sessionPath = "/sessions/session.jsonl";

describe("FileSystemServiceTest", () => {
  it.effect("serves configured per-path values and failures", () => {
    const deniedPath = "/sessions/denied.jsonl";
    const denied = new FileSystemError({
      operation: "readTextFile",
      path: deniedPath,
      message: "permission denied",
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const controls = yield* FileSystemServiceTest;

      expect(yield* fileSystem.exists(sessionPath)).toBe(true);
      expect(yield* fileSystem.statMtimeMs(sessionPath)).toBe(1234);
      expect(yield* fileSystem.readTextFile(sessionPath)).toBe("héllo\n");
      expect(yield* Effect.flip(fileSystem.readTextFile(deniedPath))).toEqual(
        denied,
      );
      yield* controls.clearFailure("readTextFile", deniedPath);
      expect(yield* fileSystem.readTextFile(deniedPath)).toBe(
        "failure takes priority",
      );
      expect((yield* controls.getState).calls).toEqual([
        { operation: "exists", path: sessionPath },
        { operation: "statMtimeMs", path: sessionPath },
        { operation: "readTextFile", path: sessionPath },
        { operation: "readTextFile", path: deniedPath },
        { operation: "readTextFile", path: deniedPath },
      ]);
    }).pipe(
      Effect.provide(
        FileSystemServiceTest.layer({
          exists: new Map([[sessionPath, true]]),
          mtimes: new Map([[sessionPath, 1234]]),
          contents: new Map([
            [sessionPath, "héllo\n"],
            [deniedPath, "failure takes priority"],
          ]),
          failures: new Map([
            ["readTextFile", new Map([[deniedPath, denied]])],
          ]),
        }),
      ),
    );
  });

  it.effect("does not expose configured failure objects", () => {
    const deniedPath = "/sessions/denied.jsonl";
    const denied = new FileSystemError({
      operation: "readTextFile",
      path: deniedPath,
      message: "permission denied",
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const controls = yield* FileSystemServiceTest;

      const received = yield* Effect.flip(fileSystem.readTextFile(deniedPath));
      expect(received).toBeInstanceOf(FileSystemError);
      Object.assign(received, {
        path: "/mutated/path",
        message: "mutated message",
      });

      const currentFailure = (yield* controls.getState).failures
        .get("readTextFile")
        ?.get(deniedPath);
      expect(currentFailure).toMatchObject({
        _tag: "FileSystemError",
        operation: "readTextFile",
        path: deniedPath,
        message: "permission denied",
      });

      yield* controls.reset;

      const resetFailure = (yield* controls.getState).failures
        .get("readTextFile")
        ?.get(deniedPath);
      expect(resetFailure).toMatchObject({
        _tag: "FileSystemError",
        operation: "readTextFile",
        path: deniedPath,
        message: "permission denied",
      });
    }).pipe(
      Effect.provide(
        FileSystemServiceTest.layer({
          failures: new Map([
            ["readTextFile", new Map([[deniedPath, denied]])],
          ]),
        }),
      ),
    );
  });

  it.effect("resetCalls preserves configured values", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const controls = yield* FileSystemServiceTest;
      yield* fileSystem.exists(sessionPath);

      yield* controls.resetCalls;

      const state = yield* controls.getState;
      expect(state.calls).toEqual([]);
      expect(state.exists).toEqual(new Map([[sessionPath, false]]));
      expect(yield* fileSystem.exists(sessionPath)).toBe(false);
    }).pipe(
      Effect.provide(
        FileSystemServiceTest.layer({
          exists: new Map([[sessionPath, false]]),
        }),
      ),
    ),
  );

  it.effect("reset completely restores copied initial configuration", () => {
    const initialExists = new Map([[sessionPath, true]]);
    const initialMtimes = new Map([[sessionPath, 100]]);
    const initialContents = new Map([[sessionPath, "initial"]]);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const controls = yield* FileSystemServiceTest;

      initialExists.set(sessionPath, false);
      initialMtimes.set(sessionPath, 999);
      initialContents.set(sessionPath, "mutated outside");
      yield* controls.setExists(sessionPath, false);
      yield* controls.setMtime(sessionPath, 200);
      yield* controls.setContent(sessionPath, "changed");
      yield* controls.setFailure(
        "exists",
        sessionPath,
        new FileSystemError({
          operation: "exists",
          path: sessionPath,
          message: "changed failure",
        }),
      );

      yield* controls.reset;

      const state = yield* controls.getState;
      expect(state.calls).toEqual([]);
      expect(state.exists).toEqual(new Map([[sessionPath, true]]));
      expect(state.mtimes).toEqual(new Map([[sessionPath, 100]]));
      expect(state.contents).toEqual(new Map([[sessionPath, "initial"]]));
      expect(state.failures).toEqual(new Map());
      expect(yield* fileSystem.exists(sessionPath)).toBe(true);
    }).pipe(
      Effect.provide(
        FileSystemServiceTest.layer({
          exists: initialExists,
          mtimes: initialMtimes,
          contents: initialContents,
        }),
      ),
    );
  });

  it.effect(
    "returns configured mutation failures without changing content",
    () => {
      const path = "/runs/status.json";
      const denied = new FileSystemError({
        operation: "writeTextFile",
        path,
        message: "permission denied",
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const controls = yield* FileSystemServiceTest;

        expect(
          yield* Effect.flip(
            fileSystem.writeTextFile(path, "changed\n", { mode: 0o600 }),
          ),
        ).toEqual(denied);
        expect((yield* controls.getState).contents).toEqual(
          new Map([[path, "original\n"]]),
        );
      }).pipe(
        Effect.provide(
          FileSystemServiceTest.layer({
            contents: new Map([[path, "original\n"]]),
            failures: new Map([["writeTextFile", new Map([[path, denied]])]]),
          }),
        ),
      );
    },
  );

  it.effect("returns copied call and map snapshots", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const controls = yield* FileSystemServiceTest;
      yield* fileSystem.readTextFile(sessionPath);

      const first = yield* controls.getState;
      const second = yield* controls.getState;
      Object.assign(first.calls[0] ?? {}, { path: "/mutated" });

      expect(first.calls).not.toBe(second.calls);
      expect(first.exists).not.toBe(second.exists);
      expect(first.mtimes).not.toBe(second.mtimes);
      expect(first.contents).not.toBe(second.contents);
      expect(first.failures).not.toBe(second.failures);
      expect(second.calls).toEqual([
        { operation: "readTextFile", path: sessionPath },
      ]);
    }).pipe(
      Effect.provide(
        FileSystemServiceTest.layer({
          contents: new Map([[sessionPath, "content"]]),
        }),
      ),
    ),
  );

  it.effect(
    "serves configured directories, metadata, and real paths and records mutation calls",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const controls = yield* FileSystemServiceTest;

        expect(yield* fileSystem.readDirectory("/agents")).toEqual([
          { name: "reader.md", kind: "file" },
        ]);
        expect(yield* fileSystem.stat("/agents")).toEqual({
          kind: "directory",
          mtimeMs: 1,
          mode: 0o700,
        });
        expect(yield* fileSystem.realPath("/agents")).toBe("/real/agents");

        yield* fileSystem.writeTextFile("/runs/status.json", "{}\n", {
          mode: 0o600,
        });
        yield* fileSystem.rename("/runs/status.json", "/runs/status.old.json");

        const state = yield* controls.getState;
        expect(state.calls).toContainEqual({
          operation: "writeTextFile",
          path: "/runs/status.json",
          content: "{}\n",
          mode: 0o600,
        });
        expect(state.calls).toContainEqual({
          operation: "rename",
          path: "/runs/status.json -> /runs/status.old.json",
          from: "/runs/status.json",
          to: "/runs/status.old.json",
        });
      }).pipe(
        Effect.provide(
          FileSystemServiceTest.layer({
            directories: new Map([
              ["/agents", [{ name: "reader.md", kind: "file" }]],
            ]),
            metadata: new Map([
              ["/agents", { kind: "directory", mtimeMs: 1, mode: 0o700 }],
            ]),
            realPaths: new Map([["/agents", "/real/agents"]]),
          }),
        ),
      ),
  );

  it.effect("treats rename with an unknown source as unconfigured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const controls = yield* FileSystemServiceTest;
      const source = "/runs/missing.tmp";
      const target = "/runs/status.json";

      const exit = yield* Effect.exit(fileSystem.rename(source, target));
      const state = yield* controls.getState;

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.isDie(exit.cause)).toBe(true);
        const defect = Cause.dieOption(exit.cause);
        expect(Option.isSome(defect)).toBe(true);
        if (Option.isSome(defect)) {
          expect(String(defect.value)).toContain(
            `FileSystemServiceTest.rename is not configured for ${source} -> ${target}`,
          );
        }
      }
      expect(state.calls).toEqual([
        {
          operation: "rename",
          path: `${source} -> ${target}`,
          from: source,
          to: target,
        },
      ]);
      expect(state.exists).toEqual(new Map());
      expect(state.mtimes).toEqual(new Map());
      expect(state.directories).toEqual(new Map());
      expect(state.metadata).toEqual(new Map());
      expect(state.realPaths).toEqual(new Map());
      expect(state.contents).toEqual(new Map());
    }).pipe(Effect.provide(FileSystemServiceTest.layer())),
  );

  it.effect(
    "rejects an absent rename source without replacing the destination",
    () => {
      const source = "/runs/missing.tmp";
      const target = "/runs/status.json";

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const controls = yield* FileSystemServiceTest;

        const error = yield* Effect.flip(fileSystem.rename(source, target));
        const state = yield* controls.getState;

        expect(error).toMatchObject({
          _tag: "FileSystemError",
          operation: "rename",
          path: `${source} -> ${target}`,
        });
        expect(state.exists.get(source)).toBe(false);
        expect(state.contents.get(target)).toBe("visible\n");
        expect(state.metadata.get(target)).toEqual({
          kind: "file",
          mtimeMs: 10,
          mode: 0o600,
        });
        expect(state.realPaths.get(target)).toBe(target);
        expect(state.directories.get("/runs")).toEqual([
          { name: "status.json", kind: "file" },
        ]);
      }).pipe(
        Effect.provide(
          FileSystemServiceTest.layer({
            exists: new Map([[source, false]]),
            directories: new Map([
              ["/runs", [{ name: "status.json", kind: "file" }]],
            ]),
            metadata: new Map([
              [target, { kind: "file", mtimeMs: 10, mode: 0o600 }],
            ]),
            realPaths: new Map([[target, target]]),
            contents: new Map([[target, "visible\n"]]),
          }),
        ),
      );
    },
  );

  it.effect(
    "updates fake state for writes, appends, renames, and removes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;

        yield* fileSystem.writeTextFile("/runs/status.json", '{"status":1}\n', {
          mode: 0o600,
        });
        expect(yield* fileSystem.readTextFile("/runs/status.json")).toBe(
          '{"status":1}\n',
        );
        expect(yield* fileSystem.readDirectory("/runs")).toEqual([
          { name: "status.json", kind: "file" },
        ]);
        expect(yield* fileSystem.realPath("/runs/status.json")).toBe(
          "/runs/status.json",
        );

        yield* fileSystem.appendTextFile("/runs/status.json", "tail\n");
        expect(yield* fileSystem.readTextFile("/runs/status.json")).toBe(
          '{"status":1}\ntail\n',
        );

        yield* fileSystem.writeTextFile(
          "/runs/status.old.json",
          "stale target\n",
          { mode: 0o600 },
        );
        yield* fileSystem.rename("/runs/status.json", "/runs/status.old.json");
        expect(yield* fileSystem.exists("/runs/status.json")).toBe(false);
        expect(yield* fileSystem.readTextFile("/runs/status.old.json")).toBe(
          '{"status":1}\ntail\n',
        );
        expect(yield* fileSystem.stat("/runs/status.old.json")).toMatchObject({
          kind: "file",
          mode: 0o600,
        });

        yield* fileSystem.remove("/runs/status.old.json");
        expect(yield* fileSystem.exists("/runs/status.old.json")).toBe(false);
        expect(yield* fileSystem.readDirectory("/runs")).toEqual([]);
      }).pipe(
        Effect.provide(
          FileSystemServiceTest.layer({
            directories: new Map([["/runs", []]]),
            metadata: new Map([
              ["/runs", { kind: "directory", mtimeMs: 1, mode: 0o700 }],
            ]),
            realPaths: new Map([["/runs", "/runs"]]),
          }),
        ),
      ),
  );

  it.effect("uses explicit Windows semantics for parent listings", () => {
    const runDirectory = "C:\\runs";
    const statusPath = win32.join(runDirectory, "status.json");

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;

      yield* fileSystem.makeDirectory(runDirectory, {
        recursive: false,
        mode: 0o700,
      });
      yield* fileSystem.writeTextFile(statusPath, "{}\n", { mode: 0o600 });

      expect(yield* fileSystem.readDirectory(runDirectory)).toEqual([
        { name: "status.json", kind: "file" },
      ]);
    }).pipe(
      Effect.provide(FileSystemServiceTest.layer({ pathStyle: "win32" })),
    );
  });

  it.effect("removes Windows descendants recursively", () => {
    const runDirectory = "C:\\runs";
    const nestedDirectory = win32.join(runDirectory, "nested");
    const statusPath = win32.join(nestedDirectory, "status.json");

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;

      yield* fileSystem.makeDirectory(runDirectory, {
        recursive: false,
        mode: 0o700,
      });
      yield* fileSystem.makeDirectory(nestedDirectory, {
        recursive: false,
        mode: 0o700,
      });
      yield* fileSystem.writeTextFile(statusPath, "{}\n", { mode: 0o600 });

      yield* fileSystem.remove(runDirectory, { recursive: true });

      expect(yield* fileSystem.exists(runDirectory)).toBe(false);
      expect(yield* fileSystem.exists(nestedDirectory)).toBe(false);
      expect(yield* fileSystem.exists(statusPath)).toBe(false);
    }).pipe(
      Effect.provide(FileSystemServiceTest.layer({ pathStyle: "win32" })),
    );
  });

  it.effect(
    "requires recursive removal for directories and removes the full tree",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const runDirectory = "/runs";
        const nestedDirectory = "/runs/nested";
        const nestedFile = "/runs/nested/status.json";

        yield* fileSystem.makeDirectory(runDirectory, {
          recursive: false,
          mode: 0o700,
        });
        yield* fileSystem.makeDirectory(nestedDirectory, {
          recursive: false,
          mode: 0o700,
        });
        yield* fileSystem.writeTextFile(nestedFile, "{}\n", { mode: 0o600 });

        const error = yield* Effect.flip(fileSystem.remove(runDirectory));

        expect(error).toBeInstanceOf(FileSystemError);
        expect(error).toMatchObject({
          operation: "remove",
          path: runDirectory,
        });
        expect(yield* fileSystem.readTextFile(nestedFile)).toBe("{}\n");

        yield* fileSystem.remove(runDirectory, { recursive: true });
        expect(yield* fileSystem.exists(runDirectory)).toBe(false);
        expect(yield* fileSystem.exists(nestedDirectory)).toBe(false);
        expect(yield* fileSystem.exists(nestedFile)).toBe(false);
      }).pipe(Effect.provide(FileSystemServiceTest.layer())),
  );

  it.effect(
    "returns copied directory, metadata, and real path snapshots and supports new controls",
    () =>
      Effect.gen(function* () {
        const controls = yield* FileSystemServiceTest;

        yield* controls.setDirectory("/agents", [
          { name: "reader.md", kind: "file" },
        ]);
        yield* controls.setMetadata("/agents", {
          kind: "directory",
          mtimeMs: 2,
          mode: 0o700,
        });
        yield* controls.setRealPath("/agents", "/real/agents");
        yield* controls.setContent("/agents/reader.md", "content\n");

        const first = yield* controls.getState;
        const second = yield* controls.getState;

        Object.assign(first.directories.get("/agents")?.[0] ?? {}, {
          name: "writer.md",
        });
        Object.assign(first.metadata.get("/agents") ?? {}, {
          kind: "other",
          mtimeMs: 0,
          mode: 0,
        });

        expect(first.directories).not.toBe(second.directories);
        expect(first.metadata).not.toBe(second.metadata);
        expect(first.realPaths).not.toBe(second.realPaths);
        expect(second.directories.get("/agents")).toEqual([
          { name: "reader.md", kind: "file" },
        ]);
        expect(second.metadata.get("/agents")).toEqual({
          kind: "directory",
          mtimeMs: 2,
          mode: 0o700,
        });
        expect(second.realPaths.get("/agents")).toBe("/real/agents");
      }).pipe(Effect.provide(FileSystemServiceTest.layer())),
  );

  it.effect("records an unconfigured operation before dying", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const controls = yield* FileSystemServiceTest;

      const exit = yield* Effect.exit(fileSystem.statMtimeMs(sessionPath));
      const state = yield* controls.getState;

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.isDie(exit.cause)).toBe(true);
        const defect = Cause.dieOption(exit.cause);
        expect(Option.isSome(defect)).toBe(true);
        if (Option.isSome(defect)) {
          expect(String(defect.value)).toContain(
            "FileSystemServiceTest.statMtimeMs is not configured for /sessions/session.jsonl",
          );
        }
      }
      expect(state.calls).toEqual([
        { operation: "statMtimeMs", path: sessionPath },
      ]);
    }).pipe(Effect.provide(FileSystemServiceTest.layer())),
  );
});
