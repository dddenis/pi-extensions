import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { expect } from "vitest";
import { FileSystemServiceTest } from "../../test/services/file-system";
import { HistoryPickerServicesTest } from "../../test/services/history-picker";
import { FileSystemError } from "../services/file-system";
import { SessionListingError } from "./services";
import { makeHistoryIndexer } from "./session-indexer";

const onePath = "/sessions/one.jsonl";
const twoPath = "/sessions/two.jsonl";
const badPath = "/sessions/bad.jsonl";

const session = (path: string, cwd = "/listing/project"): SessionInfo => ({
  path,
  id: `id-${path}`,
  cwd,
  created: new Date("2026-01-01T00:00:00.000Z"),
  modified: new Date("2026-01-02T00:00:00.000Z"),
  messageCount: 1,
  firstMessage: "hello",
  allMessagesText: "hello",
});

const jsonl = (text: string, timestamp: number, cwd = "/header/project") =>
  [
    JSON.stringify({
      type: "session",
      version: 3,
      id: `session-${text}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    }),
    JSON.stringify({
      type: "message",
      id: `message-${text}`,
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: text, timestamp },
    }),
  ].join("\n");

const layer = (
  outcomes: ReadonlyArray<
    | {
        readonly _tag: "Success";
        readonly sessions: ReadonlyArray<SessionInfo>;
      }
    | { readonly _tag: "Failure"; readonly error: SessionListingError }
  >,
) =>
  Layer.merge(
    HistoryPickerServicesTest.layer({ listingOutcomes: outcomes }),
    FileSystemServiceTest.layer({
      mtimes: new Map([
        [onePath, 1],
        [twoPath, 1],
        [badPath, 1],
      ]),
      contents: new Map([
        [onePath, jsonl("one", 1)],
        [twoPath, jsonl("two", 2)],
        [badPath, "{broken"],
      ]),
    }),
  );

describe("history session indexer", () => {
  it.effect(
    "starts with the current snapshot, indexes saved files, reuses unchanged files, rereads changes, and evicts deletions",
    () =>
      Effect.gen(function* () {
        const indexer = yield* makeHistoryIndexer;
        const listing = yield* HistoryPickerServicesTest;
        const files = yield* FileSystemServiceTest;

        expect(yield* indexer.snapshot).toEqual({
          savedItems: [],
          loading: false,
        });

        const first = yield* indexer.refresh;
        expect(first).toEqual({
          savedItems: [
            {
              text: "one",
              timestamp: 1,
              sessionFile: onePath,
              cwd: "/header/project",
              source: "saved",
            },
          ],
          loading: false,
        });

        yield* files.resetCalls;
        yield* listing.enqueueSuccess([session(onePath)]);
        const unchanged = yield* indexer.refresh;
        expect(unchanged.savedItems).toEqual(first.savedItems);
        expect((yield* files.getState).calls).toEqual([
          { operation: "statMtimeMs", path: onePath },
        ]);

        yield* files.setMtime(onePath, 2);
        yield* files.setContent(onePath, jsonl("changed", 3));
        yield* files.resetCalls;
        yield* listing.enqueueSuccess([session(onePath)]);
        expect((yield* indexer.refresh).savedItems[0]?.text).toBe("changed");
        expect((yield* files.getState).calls).toEqual([
          { operation: "statMtimeMs", path: onePath },
          { operation: "readTextFile", path: onePath },
        ]);

        yield* listing.enqueueSuccess([]);
        expect((yield* indexer.refresh).savedItems).toEqual([]);
        yield* indexer.shutdown;
      }).pipe(
        Effect.provide(
          layer([{ _tag: "Success", sessions: [session(onePath)] }]),
        ),
      ),
  );

  it.effect(
    "distinguishes failed listing retention from successful empty eviction",
    () =>
      Effect.gen(function* () {
        const indexer = yield* makeHistoryIndexer;
        const listing = yield* HistoryPickerServicesTest;

        const before = yield* indexer.refresh;
        yield* listing.enqueueFailure(
          new SessionListingError({ message: "offline" }),
        );
        const failed = yield* indexer.refresh;
        expect(failed.savedItems).toEqual(before.savedItems);
        expect(failed.warning).toContain("Saved sessions unavailable");

        yield* listing.enqueueSuccess([]);
        const empty = yield* indexer.refresh;
        expect(empty.savedItems).toEqual([]);
        expect(empty.warning).toBeUndefined();
        yield* indexer.shutdown;
      }).pipe(
        Effect.provide(
          layer([{ _tag: "Success", sessions: [session(onePath)] }]),
        ),
      ),
  );

  it.effect(
    "retains prior valid paths on stat, read, and parse failures and omits bad new paths",
    () =>
      Effect.gen(function* () {
        const indexer = yield* makeHistoryIndexer;
        const listing = yield* HistoryPickerServicesTest;
        const files = yield* FileSystemServiceTest;
        const before = yield* indexer.refresh;

        yield* files.setFailure(
          "statMtimeMs",
          onePath,
          new FileSystemError({
            operation: "statMtimeMs",
            path: onePath,
            message: "stat denied",
          }),
        );
        yield* listing.enqueueSuccess([session(onePath), session(badPath)]);
        const statAndNewParseFailure = yield* indexer.refresh;
        expect(statAndNewParseFailure.savedItems).toEqual(before.savedItems);
        expect(statAndNewParseFailure.warning).toContain(
          "Some saved sessions could not be read",
        );

        yield* files.clearFailure("statMtimeMs", onePath);
        yield* files.setMtime(onePath, 2);
        yield* files.setFailure(
          "readTextFile",
          onePath,
          new FileSystemError({
            operation: "readTextFile",
            path: onePath,
            message: "read denied",
          }),
        );
        yield* listing.enqueueSuccess([session(onePath)]);
        expect((yield* indexer.refresh).savedItems).toEqual(before.savedItems);

        yield* files.clearFailure("readTextFile", onePath);
        yield* files.setContent(onePath, "{broken");
        yield* listing.enqueueSuccess([session(onePath)]);
        expect((yield* indexer.refresh).savedItems).toEqual(before.savedItems);
        yield* indexer.shutdown;
      }).pipe(
        Effect.provide(
          layer([{ _tag: "Success", sessions: [session(onePath)] }]),
        ),
      ),
  );

  it.effect(
    "shares one atomic listing and read across concurrent refresh callers",
    () =>
      Effect.gen(function* () {
        const controls = yield* HistoryPickerServicesTest;
        const pending = yield* controls.enqueuePending();
        const indexer = yield* makeHistoryIndexer;

        const first = yield* Effect.fork(indexer.refresh);
        const second = yield* Effect.fork(indexer.refresh);
        yield* Effect.yieldNow();
        yield* Effect.yieldNow();
        expect((yield* controls.getState).listCalls).toBe(1);

        yield* Deferred.succeed(pending, [session(onePath)]);
        const firstSnapshot = yield* Fiber.join(first);
        const secondSnapshot = yield* Fiber.join(second);
        expect(firstSnapshot).toEqual(secondSnapshot);
        expect(firstSnapshot).not.toBe(secondSnapshot);

        const files = yield* FileSystemServiceTest;
        expect(
          (yield* files.getState).calls.filter(
            (call) => call.operation === "readTextFile",
          ),
        ).toHaveLength(1);
        yield* indexer.shutdown;
      }).pipe(Effect.provide(layer([]))),
  );

  it.effect(
    "publishes immediately, copies snapshots, and safely removes listeners",
    () =>
      Effect.gen(function* () {
        const indexer = yield* makeHistoryIndexer;
        const received: Array<{ saved: number; loading: boolean }> = [];
        const remove = yield* indexer.subscribe((snapshot) => {
          received.push({
            saved: snapshot.savedItems.length,
            loading: snapshot.loading,
          });
        });

        expect(received).toEqual([{ saved: 0, loading: false }]);
        const refreshed = yield* indexer.refresh;
        expect(received).toContainEqual({ saved: 0, loading: true });
        expect(received.at(-1)).toEqual({ saved: 1, loading: false });

        Object.assign(refreshed.savedItems[0] ?? {}, { text: "mutated" });
        expect((yield* indexer.snapshot).savedItems[0]?.text).toBe("one");

        yield* remove;
        yield* remove;
        const listing = yield* HistoryPickerServicesTest;
        yield* listing.enqueueSuccess([]);
        yield* indexer.refresh;
        expect(received.at(-1)).toEqual({ saved: 1, loading: false });
        yield* indexer.shutdown;
      }).pipe(
        Effect.provide(
          layer([{ _tag: "Success", sessions: [session(onePath)] }]),
        ),
      ),
  );

  it.effect(
    "shutdown interrupts the in-flight refresh, removes listeners, and is idempotent",
    () =>
      Effect.gen(function* () {
        const controls = yield* HistoryPickerServicesTest;
        const pending = yield* controls.enqueuePending();
        const indexer = yield* makeHistoryIndexer;
        let publications = 0;
        const remove = yield* indexer.subscribe(() => {
          publications += 1;
        });

        const refreshFiber = yield* Effect.fork(indexer.refresh);
        yield* Effect.yieldNow();
        yield* Effect.yieldNow();
        expect((yield* controls.getState).listCalls).toBe(1);

        yield* indexer.shutdown;
        yield* indexer.shutdown;
        yield* remove;
        expect(yield* Deferred.isDone(pending)).toBe(false);
        const exit = yield* Fiber.await(refreshFiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
        }

        const atShutdown = publications;
        const after = yield* indexer.refresh;
        expect(after.loading).toBe(false);
        expect(publications).toBe(atShutdown);
        expect((yield* controls.getState).listCalls).toBe(1);
      }).pipe(Effect.provide(layer([]))),
  );
});
