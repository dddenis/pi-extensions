import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { expect } from "vitest";
import {
  FileSystemError,
  FileSystemService,
} from "../../src/services/file-system";
import {
  FileSystemServiceTest,
  type FileSystemServiceTestPrivateFile,
} from "./file-system";

const sessionPath = "/sessions/session.jsonl";

describe("FileSystemServiceTest", () => {
  it.effect(
    "records private-file replacement and removal as stateful mutations",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const controls = yield* FileSystemServiceTest;
        const markerPath = "/tmp/tmux/default.tmux-attention-v1-23-7";

        yield* fileSystem.replaceWithPrivateEmptyFile(markerPath);
        expect((yield* controls.getState).privateFiles.get(markerPath)).toEqual(
          {
            contents: "",
            mode: 0o600,
          },
        );

        yield* fileSystem.removeFile(markerPath);
        const state = yield* controls.getState;
        expect(state.privateFiles.has(markerPath)).toBe(false);
        expect(state.calls).toEqual([
          { operation: "replaceWithPrivateEmptyFile", path: markerPath },
          { operation: "removeFile", path: markerPath },
        ]);
      }).pipe(Effect.provide(FileSystemServiceTest.layer())),
  );

  it.effect(
    "does not mutate on failure and allows the same operation to retry",
    () => {
      const markerPath = "/tmp/tmux/default.tmux-attention-v1-23-7";
      const denied = new FileSystemError({
        operation: "replaceWithPrivateEmptyFile",
        path: markerPath,
        message: "permission denied",
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const controls = yield* FileSystemServiceTest;

        yield* Effect.flip(fileSystem.replaceWithPrivateEmptyFile(markerPath));
        const failedState = yield* controls.getState;
        expect(failedState.privateFiles.has(markerPath)).toBe(false);
        expect(failedState.calls).toEqual([
          { operation: "replaceWithPrivateEmptyFile", path: markerPath },
        ]);

        yield* controls.clearFailure("replaceWithPrivateEmptyFile", markerPath);
        yield* fileSystem.replaceWithPrivateEmptyFile(markerPath);
        expect((yield* controls.getState).privateFiles.get(markerPath)).toEqual(
          {
            contents: "",
            mode: 0o600,
          },
        );
      }).pipe(
        Effect.provide(
          FileSystemServiceTest.layer({
            failures: new Map([
              ["replaceWithPrivateEmptyFile", new Map([[markerPath, denied]])],
            ]),
          }),
        ),
      );
    },
  );

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
      const markerPath = "/tmp/tmux/default.tmux-attention-v1-23-7";
      yield* fileSystem.exists(sessionPath);
      yield* fileSystem.replaceWithPrivateEmptyFile(markerPath);

      yield* controls.resetCalls;

      const state = yield* controls.getState;
      expect(state.calls).toEqual([]);
      expect(state.exists).toEqual(new Map([[sessionPath, false]]));
      expect(state.privateFiles).toEqual(
        new Map([[markerPath, { contents: "", mode: 0o600 }]]),
      );
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
    const markerPath = "/tmp/tmux/default.tmux-attention-v1-23-7";
    const addedMarkerPath = "/tmp/tmux/default.tmux-attention-v1-23-8";
    const initialExists = new Map([[sessionPath, true]]);
    const initialMtimes = new Map([[sessionPath, 100]]);
    const initialContents = new Map([[sessionPath, "initial"]]);
    const initialPrivateFile: FileSystemServiceTestPrivateFile = {
      contents: "",
      mode: 0o600,
    };
    const initialPrivateFiles = new Map<
      string,
      FileSystemServiceTestPrivateFile
    >([[markerPath, initialPrivateFile]]);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const controls = yield* FileSystemServiceTest;

      initialExists.set(sessionPath, false);
      initialMtimes.set(sessionPath, 999);
      initialContents.set(sessionPath, "mutated outside");
      initialPrivateFiles.clear();
      Object.assign(initialPrivateFile, { mode: 0o644 });
      yield* controls.setExists(sessionPath, false);
      yield* controls.setMtime(sessionPath, 200);
      yield* controls.setContent(sessionPath, "changed");
      yield* fileSystem.removeFile(markerPath);
      yield* fileSystem.replaceWithPrivateEmptyFile(addedMarkerPath);
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
      expect(state.privateFiles).toEqual(
        new Map([[markerPath, { contents: "", mode: 0o600 }]]),
      );
      expect(state.failures).toEqual(new Map());
      expect(yield* fileSystem.exists(sessionPath)).toBe(true);
    }).pipe(
      Effect.provide(
        FileSystemServiceTest.layer({
          exists: initialExists,
          mtimes: initialMtimes,
          contents: initialContents,
          privateFiles: initialPrivateFiles,
        }),
      ),
    );
  });

  it.effect("returns copied call and map snapshots", () => {
    const markerPath = "/tmp/tmux/default.tmux-attention-v1-23-7";
    const privateFile: FileSystemServiceTestPrivateFile = {
      contents: "",
      mode: 0o600,
    };

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const controls = yield* FileSystemServiceTest;
      yield* fileSystem.readTextFile(sessionPath);

      const first = yield* controls.getState;
      const second = yield* controls.getState;
      Object.assign(first.calls[0] ?? {}, { path: "/mutated" });
      const firstPrivateFile = first.privateFiles.get(markerPath);
      const secondPrivateFile = second.privateFiles.get(markerPath);

      expect(first.calls).not.toBe(second.calls);
      expect(first.exists).not.toBe(second.exists);
      expect(first.mtimes).not.toBe(second.mtimes);
      expect(first.contents).not.toBe(second.contents);
      expect(first.privateFiles).not.toBe(second.privateFiles);
      expect(firstPrivateFile).not.toBe(secondPrivateFile);
      Object.assign(firstPrivateFile ?? {}, { mode: 0o644 });
      expect(secondPrivateFile).toEqual({ contents: "", mode: 0o600 });
      expect(first.failures).not.toBe(second.failures);
      expect(second.calls).toEqual([
        { operation: "readTextFile", path: sessionPath },
      ]);
    }).pipe(
      Effect.provide(
        FileSystemServiceTest.layer({
          contents: new Map([[sessionPath, "content"]]),
          privateFiles: new Map([[markerPath, privateFile]]),
        }),
      ),
    );
  });

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
