import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref, Runtime } from "effect";
import { expect } from "vitest";
import {
  EnvironmentServiceTest,
  FileSystemServiceTest,
} from "../../test/services";
import {
  FileSystemError,
  FileSystemService,
  type FileSystemOperation,
  type FileSystemService as FileSystemServiceShape,
} from "../services/file-system";
import { makeTmuxMarker } from "./tmux-marker";

type ExtensionMode = ExtensionContext["mode"];

const tmux = "/private/tmp/tmux,501/default,2301,9";
const paneId = "%47";
const markerPath = "/private/tmp/tmux,501/default.tmux-attention-v1-2301-47";

const layer = (values: Readonly<Record<string, string>>) =>
  Layer.mergeAll(
    EnvironmentServiceTest.layer({ values }),
    FileSystemServiceTest.layer(),
  );

const disabledCases: ReadonlyArray<{
  readonly name: string;
  readonly mode: ExtensionMode;
  readonly values: Readonly<Record<string, string>>;
  readonly interactiveRoot: boolean;
}> = [
  {
    name: "does nothing outside TUI mode",
    mode: "rpc",
    values: { TMUX: tmux, TMUX_PANE: paneId },
    interactiveRoot: false,
  },
  {
    name: "does nothing for the exact subagent child marker",
    mode: "tui",
    values: { PI_SUBAGENT_CHILD: "1", TMUX: tmux, TMUX_PANE: paneId },
    interactiveRoot: false,
  },
  {
    name: "does nothing without TMUX",
    mode: "tui",
    values: { TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing with empty TMUX",
    mode: "tui",
    values: { TMUX: "", TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing when TMUX has fewer than two commas",
    mode: "tui",
    values: { TMUX: "/private/tmp/tmux,2301", TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing with an empty tmux socket path",
    mode: "tui",
    values: { TMUX: ",2301,9", TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing without a pane id",
    mode: "tui",
    values: { TMUX: tmux },
    interactiveRoot: true,
  },
  {
    name: "does nothing with an empty pane id",
    mode: "tui",
    values: { TMUX: tmux, TMUX_PANE: "" },
    interactiveRoot: true,
  },
  {
    name: "does nothing with a missing tmux server PID",
    mode: "tui",
    values: { TMUX: "/private/tmp/tmux,,9", TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing with a negative tmux server PID",
    mode: "tui",
    values: { TMUX: "/private/tmp/tmux,-2301,9", TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing with a non-ASCII tmux server PID",
    mode: "tui",
    values: { TMUX: "/private/tmp/tmux,２３０１,9", TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing with a missing tmux session ID",
    mode: "tui",
    values: { TMUX: "/private/tmp/tmux,2301,", TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing with a negative tmux session ID",
    mode: "tui",
    values: { TMUX: "/private/tmp/tmux,2301,-9", TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing with a non-ASCII tmux session ID",
    mode: "tui",
    values: { TMUX: "/private/tmp/tmux,2301,９", TMUX_PANE: paneId },
    interactiveRoot: true,
  },
  {
    name: "does nothing with a pane id without a percent prefix",
    mode: "tui",
    values: { TMUX: tmux, TMUX_PANE: "47" },
    interactiveRoot: true,
  },
  {
    name: "does nothing with a pane id containing an extra percent",
    mode: "tui",
    values: { TMUX: tmux, TMUX_PANE: "%%47" },
    interactiveRoot: true,
  },
  {
    name: "does nothing with non-ASCII pane digits",
    mode: "tui",
    values: { TMUX: tmux, TMUX_PANE: "%４７" },
    interactiveRoot: true,
  },
];

for (const testCase of disabledCases) {
  it.effect(testCase.name, () =>
    Effect.gen(function* () {
      const marker = yield* makeTmuxMarker(testCase.mode);
      const files = yield* FileSystemServiceTest;

      yield* marker.setWaiting(true);

      expect(marker.interactiveRoot).toBe(testCase.interactiveRoot);
      expect((yield* files.getState).calls).toEqual([]);
    }).pipe(Effect.provide(layer(testCase.values))),
  );
}

it.effect("derives the v1 path from the rightmost TMUX fields", () =>
  Effect.gen(function* () {
    const marker = yield* makeTmuxMarker("tui");
    const files = yield* FileSystemServiceTest;

    expect(marker.interactiveRoot).toBe(true);

    yield* marker.setWaiting(true);
    let state = yield* files.getState;
    expect(state.calls).toEqual([
      { operation: "replaceWithPrivateEmptyFile", path: markerPath },
    ]);
    expect(state.privateFiles.get(markerPath)).toEqual({
      contents: "",
      mode: 0o600,
    });

    yield* marker.setWaiting(false);
    state = yield* files.getState;
    expect(state.calls.at(-1)).toEqual({
      operation: "removeFile",
      path: markerPath,
    });
    expect(state.privateFiles.has(markerPath)).toBe(false);
  }).pipe(
    Effect.provide(
      layer({
        PI_SUBAGENT_CHILD: "true",
        TMUX: tmux,
        TMUX_PANE: paneId,
      }),
    ),
  ),
);

it.effect("forces one initial removal for stale marker cleanup", () =>
  Effect.gen(function* () {
    const marker = yield* makeTmuxMarker("tui");
    const files = yield* FileSystemServiceTest;

    yield* marker.setWaiting(false);
    yield* marker.setWaiting(false);

    expect((yield* files.getState).calls).toEqual([
      { operation: "removeFile", path: markerPath },
    ]);
  }).pipe(Effect.provide(layer({ TMUX: tmux, TMUX_PANE: paneId }))),
);

it.effect("skips a duplicate replacement after success", () =>
  Effect.gen(function* () {
    const marker = yield* makeTmuxMarker("tui");
    const files = yield* FileSystemServiceTest;

    yield* marker.setWaiting(true);
    yield* marker.setWaiting(true);

    expect((yield* files.getState).calls).toEqual([
      { operation: "replaceWithPrivateEmptyFile", path: markerPath },
    ]);
  }).pipe(Effect.provide(layer({ TMUX: tmux, TMUX_PANE: paneId }))),
);

it.effect("swallows replacement failures and retries the same request", () =>
  Effect.gen(function* () {
    const marker = yield* makeTmuxMarker("tui");
    const files = yield* FileSystemServiceTest;
    yield* files.setFailure(
      "replaceWithPrivateEmptyFile",
      markerPath,
      new FileSystemError({
        operation: "replaceWithPrivateEmptyFile",
        path: markerPath,
        message: "replacement failed",
      }),
    );

    yield* marker.setWaiting(true);
    let state = yield* files.getState;
    expect(state.privateFiles.has(markerPath)).toBe(false);

    yield* files.clearFailure("replaceWithPrivateEmptyFile", markerPath);
    yield* marker.setWaiting(true);
    state = yield* files.getState;

    expect(state.calls).toEqual([
      { operation: "replaceWithPrivateEmptyFile", path: markerPath },
      { operation: "replaceWithPrivateEmptyFile", path: markerPath },
    ]);
    expect(state.privateFiles.get(markerPath)).toEqual({
      contents: "",
      mode: 0o600,
    });
  }).pipe(Effect.provide(layer({ TMUX: tmux, TMUX_PANE: paneId }))),
);

it.effect("swallows removal failures and retries the same request", () =>
  Effect.gen(function* () {
    const marker = yield* makeTmuxMarker("tui");
    const files = yield* FileSystemServiceTest;
    yield* marker.setWaiting(true);
    yield* files.resetCalls;
    yield* files.setFailure(
      "removeFile",
      markerPath,
      new FileSystemError({
        operation: "removeFile",
        path: markerPath,
        message: "removal failed",
      }),
    );

    yield* marker.setWaiting(false);
    let state = yield* files.getState;
    expect(state.privateFiles.has(markerPath)).toBe(true);

    yield* files.clearFailure("removeFile", markerPath);
    yield* marker.setWaiting(false);
    state = yield* files.getState;

    expect(state.calls).toEqual([
      { operation: "removeFile", path: markerPath },
      { operation: "removeFile", path: markerPath },
    ]);
    expect(state.privateFiles.has(markerPath)).toBe(false);
  }).pipe(Effect.provide(layer({ TMUX: tmux, TMUX_PANE: paneId }))),
);

const unusedFileSystemOperation = (
  operation: FileSystemOperation,
  path: string,
) =>
  Effect.fail(
    new FileSystemError({ operation, path, message: "unexpected operation" }),
  );

it.effect("serializes an in-flight replacement before a newer removal", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const events: Array<string> = [];
    const markerPresent = yield* Ref.make(false);
    const fileSystem: FileSystemServiceShape = {
      exists: (path) => unusedFileSystemOperation("exists", path),
      statMtimeMs: (path) => unusedFileSystemOperation("statMtimeMs", path),
      readTextFile: (path) => unusedFileSystemOperation("readTextFile", path),
      replaceWithPrivateEmptyFile: () =>
        Effect.sync(() => {
          events.push("replace:start");
        }).pipe(
          Effect.zipRight(Deferred.succeed(entered, undefined)),
          Effect.zipRight(Deferred.await(release)),
          Effect.zipRight(
            Effect.sync(() => {
              events.push("replace:end");
            }),
          ),
          Effect.zipRight(Ref.set(markerPresent, true)),
        ),
      removeFile: () =>
        Effect.sync(() => {
          events.push("remove");
        }).pipe(Effect.zipRight(Ref.set(markerPresent, false))),
    };
    const marker = yield* makeTmuxMarker("tui").pipe(
      Effect.provide(
        Layer.mergeAll(
          EnvironmentServiceTest.layer({
            values: { TMUX: tmux, TMUX_PANE: paneId },
          }),
          Layer.succeed(FileSystemService, fileSystem),
        ),
      ),
    );

    const setting = yield* Effect.fork(marker.setWaiting(true));
    yield* Deferred.await(entered);
    const clearing = yield* Effect.fork(marker.setWaiting(false));
    yield* Effect.yieldNow();

    expect(events).toEqual(["replace:start"]);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(setting);
    yield* Fiber.join(clearing);

    expect(events).toEqual(["replace:start", "replace:end", "remove"]);
    expect(yield* Ref.get(markerPresent)).toBe(false);
  }),
);

it.effect(
  "commits interrupted replacement state before cleanup reconciliation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const published = yield* Deferred.make<void>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const markerPresent = yield* Ref.make(false);
      const runtime = yield* Effect.runtime<never>();
      const runPromise = Runtime.runPromise(runtime);
      const appendEvent = (event: string) =>
        Ref.update(events, (current) => [...current, event]);
      const fileSystem: FileSystemServiceShape = {
        exists: (path) => unusedFileSystemOperation("exists", path),
        statMtimeMs: (path) => unusedFileSystemOperation("statMtimeMs", path),
        readTextFile: (path) => unusedFileSystemOperation("readTextFile", path),
        replaceWithPrivateEmptyFile: (path) =>
          appendEvent("replace:start").pipe(
            Effect.zipRight(Deferred.succeed(entered, undefined)),
            Effect.zipRight(
              Effect.tryPromise({
                try: () =>
                  runPromise(
                    Deferred.await(release).pipe(
                      Effect.zipRight(Ref.set(markerPresent, true)),
                      Effect.zipRight(appendEvent("replace:end")),
                      Effect.zipRight(Deferred.succeed(published, undefined)),
                    ),
                  ),
                catch: () =>
                  new FileSystemError({
                    operation: "replaceWithPrivateEmptyFile",
                    path,
                    message: "replacement failed",
                  }),
              }),
            ),
          ),
        removeFile: () =>
          appendEvent("remove").pipe(
            Effect.zipRight(Ref.set(markerPresent, false)),
          ),
      };
      const marker = yield* makeTmuxMarker("tui").pipe(
        Effect.provide(
          Layer.mergeAll(
            EnvironmentServiceTest.layer({
              values: { TMUX: tmux, TMUX_PANE: paneId },
            }),
            Layer.succeed(FileSystemService, fileSystem),
          ),
        ),
      );

      yield* marker.setWaiting(false);
      yield* Ref.set(events, []);

      const setting = yield* Effect.fork(marker.setWaiting(true));
      yield* Deferred.await(entered);
      const interrupting = yield* Effect.fork(Fiber.interrupt(setting));
      yield* Effect.yieldNow();
      yield* Effect.yieldNow();
      const clearing = yield* Effect.fork(marker.setWaiting(false));
      yield* Effect.yieldNow();
      yield* Effect.yieldNow();

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      yield* Fiber.join(clearing);
      yield* Deferred.await(published);

      expect({
        events: yield* Ref.get(events),
        markerPresent: yield* Ref.get(markerPresent),
      }).toEqual({
        events: ["replace:start", "replace:end", "remove"],
        markerPresent: false,
      });
    }),
);
