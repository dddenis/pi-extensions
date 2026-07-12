import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { Deferred, Effect, Either, Fiber, Ref } from "effect";
import { FileSystemService } from "../services/file-system";
import { SessionListingService } from "./services";
import { parseSavedSessionJsonl } from "./session-items";
import type { HistoryItem, HistorySnapshot } from "./types";

export interface HistoryIndexer {
  readonly snapshot: Effect.Effect<HistorySnapshot>;
  readonly refresh: Effect.Effect<HistorySnapshot>;
  readonly subscribe: (
    listener: (snapshot: HistorySnapshot) => void,
  ) => Effect.Effect<Effect.Effect<void>>;
  readonly shutdown: Effect.Effect<void>;
}

interface CacheEntry {
  readonly mtimeMs: number;
  readonly items: ReadonlyArray<HistoryItem>;
}

type SnapshotListener = (snapshot: HistorySnapshot) => void;

interface PublicationState {
  readonly snapshot: HistorySnapshot;
  readonly listeners: ReadonlyMap<number, SnapshotListener>;
  readonly nextListenerId: number;
  readonly closed: boolean;
}

interface Flight {
  readonly deferred: Deferred.Deferred<HistorySnapshot>;
  readonly fiber?: Fiber.Fiber<boolean, never>;
}

interface ManagerState {
  readonly shutdown: boolean;
  readonly flight?: Flight;
}

type RefreshDecision =
  | { readonly _tag: "Shutdown" }
  | {
      readonly _tag: "Follow";
      readonly deferred: Deferred.Deferred<HistorySnapshot>;
    }
  | { readonly _tag: "Lead"; readonly flight: Flight };

const copyItem = (item: HistoryItem): HistoryItem => ({
  text: item.text,
  timestamp: item.timestamp,
  sessionFile: item.sessionFile,
  cwd: item.cwd,
  source: item.source,
});

const copySnapshot = (snapshot: HistorySnapshot): HistorySnapshot => ({
  savedItems: snapshot.savedItems.map(copyItem),
  loading: snapshot.loading,
  ...(snapshot.warning === undefined ? {} : { warning: snapshot.warning }),
});

const itemsFromCache = (
  cache: ReadonlyMap<string, CacheEntry>,
): ReadonlyArray<HistoryItem> =>
  [...cache.values()].flatMap((entry) => entry.items.map(copyItem));

const copyCacheEntry = (entry: CacheEntry): CacheEntry => ({
  mtimeMs: entry.mtimeMs,
  items: entry.items.map(copyItem),
});

const notify = (
  listener: SnapshotListener,
  snapshot: HistorySnapshot,
): Effect.Effect<void> =>
  Effect.sync(() => listener(copySnapshot(snapshot))).pipe(
    Effect.catchAllCause(() => Effect.void),
  );

export const makeHistoryIndexer: Effect.Effect<
  HistoryIndexer,
  never,
  FileSystemService | SessionListingService
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystemService;
  const listing = yield* SessionListingService;
  const cacheRef = yield* Ref.make<ReadonlyMap<string, CacheEntry>>(new Map());
  const publicationRef = yield* Ref.make<PublicationState>({
    snapshot: { savedItems: [], loading: false },
    listeners: new Map(),
    nextListenerId: 0,
    closed: false,
  });
  const managerRef = yield* Ref.make<ManagerState>({ shutdown: false });

  const snapshot: Effect.Effect<HistorySnapshot> = Ref.get(publicationRef).pipe(
    Effect.map((state) => copySnapshot(state.snapshot)),
  );

  const publish = (nextSnapshot: HistorySnapshot): Effect.Effect<void> =>
    Ref.modify<PublicationState, ReadonlyArray<SnapshotListener>>(
      publicationRef,
      (state) => {
        if (state.closed) {
          return [[], state];
        }
        const copied = copySnapshot(nextSnapshot);
        return [[...state.listeners.values()], { ...state, snapshot: copied }];
      },
    ).pipe(
      Effect.flatMap((listeners) =>
        Effect.forEach(
          listeners,
          (listener) => notify(listener, nextSnapshot),
          {
            discard: true,
          },
        ),
      ),
    );

  const retainPrevious = (
    next: Map<string, CacheEntry>,
    session: SessionInfo,
    previous: CacheEntry | undefined,
  ): void => {
    if (previous !== undefined) {
      next.set(session.path, copyCacheEntry(previous));
    }
  };

  const refreshSuccessfulListing = (
    sessions: ReadonlyArray<SessionInfo>,
  ): Effect.Effect<HistorySnapshot> =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const next = new Map<string, CacheEntry>();
      let failureCount = 0;

      for (const session of sessions) {
        const priorEntry = previous.get(session.path);
        const mtimeResult = yield* Effect.either(
          fileSystem.statMtimeMs(session.path),
        );
        if (Either.isLeft(mtimeResult)) {
          failureCount += 1;
          retainPrevious(next, session, priorEntry);
          continue;
        }

        if (
          priorEntry !== undefined &&
          priorEntry.mtimeMs === mtimeResult.right
        ) {
          next.set(session.path, copyCacheEntry(priorEntry));
          continue;
        }

        const contentResult = yield* Effect.either(
          fileSystem.readTextFile(session.path),
        );
        if (Either.isLeft(contentResult)) {
          failureCount += 1;
          retainPrevious(next, session, priorEntry);
          continue;
        }

        const parsedResult = yield* Effect.either(
          parseSavedSessionJsonl(
            contentResult.right,
            session.path,
            session.cwd,
          ),
        );
        if (Either.isLeft(parsedResult)) {
          failureCount += 1;
          retainPrevious(next, session, priorEntry);
          continue;
        }

        next.set(session.path, {
          mtimeMs: mtimeResult.right,
          items: parsedResult.right.map(copyItem),
        });
      }

      yield* Ref.set(cacheRef, next);
      return {
        savedItems: itemsFromCache(next),
        loading: false,
        ...(failureCount === 0
          ? {}
          : {
              warning: `Some saved sessions could not be read (${failureCount})`,
            }),
      };
    });

  const runRefresh: Effect.Effect<HistorySnapshot> = Effect.gen(function* () {
    const current = yield* snapshot;
    yield* publish({ savedItems: current.savedItems, loading: true });

    const next = yield* listing.listAll.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Ref.get(cacheRef).pipe(
            Effect.map((cache): HistorySnapshot => ({
              savedItems: itemsFromCache(cache),
              loading: false,
              warning: `Saved sessions unavailable: ${error.message}`,
            })),
          ),
        onSuccess: refreshSuccessfulListing,
      }),
    );
    yield* publish(next);
    return copySnapshot(next);
  });

  const clearFlight = (
    deferred: Deferred.Deferred<HistorySnapshot>,
  ): Effect.Effect<void> =>
    Ref.update(managerRef, (state) =>
      state.flight?.deferred === deferred
        ? { ...state, flight: undefined }
        : state,
    );

  const refresh: Effect.Effect<HistorySnapshot> = Effect.suspend(() =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<HistorySnapshot>();
        const decision = yield* Ref.modify<ManagerState, RefreshDecision>(
          managerRef,
          (state) => {
            if (state.shutdown) {
              return [{ _tag: "Shutdown" } satisfies RefreshDecision, state];
            }
            if (state.flight !== undefined) {
              return [
                {
                  _tag: "Follow",
                  deferred: state.flight.deferred,
                } satisfies RefreshDecision,
                state,
              ];
            }
            const flight: Flight = { deferred: candidate };
            return [
              { _tag: "Lead", flight } satisfies RefreshDecision,
              { ...state, flight },
            ];
          },
        );

        if (decision._tag === "Shutdown") {
          return yield* snapshot;
        }
        if (decision._tag === "Follow") {
          const followed = yield* restore(Deferred.await(decision.deferred));
          return copySnapshot(followed);
        }

        const deferred = decision.flight.deferred;
        const worker = runRefresh.pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(deferred, exit)),
          Effect.ensuring(clearFlight(deferred)),
        );
        const fiber = yield* Effect.forkDaemon(restore(worker));
        const installed = yield* Ref.modify(managerRef, (state) => {
          if (state.shutdown || state.flight?.deferred !== deferred) {
            return [false, state];
          }
          return [true, { ...state, flight: { deferred, fiber } }];
        });
        if (!installed) {
          yield* Fiber.interrupt(fiber);
        }

        const refreshed = yield* restore(Deferred.await(deferred));
        return copySnapshot(refreshed);
      }),
    ),
  );

  const subscribe = (
    listener: SnapshotListener,
  ): Effect.Effect<Effect.Effect<void>> =>
    Ref.modify<
      PublicationState,
      { readonly id?: number; readonly snapshot: HistorySnapshot }
    >(publicationRef, (state) => {
      if (state.closed) {
        return [{ snapshot: copySnapshot(state.snapshot) }, state];
      }
      const id = state.nextListenerId;
      const listeners = new Map(state.listeners);
      listeners.set(id, listener);
      return [
        { id, snapshot: copySnapshot(state.snapshot) },
        { ...state, listeners, nextListenerId: id + 1 },
      ];
    }).pipe(
      Effect.tap((registration) => notify(listener, registration.snapshot)),
      Effect.map((registration) => {
        if (registration.id === undefined) {
          return Effect.void;
        }
        const id = registration.id;
        return Ref.update(publicationRef, (state) => {
          if (!state.listeners.has(id)) {
            return state;
          }
          const listeners = new Map(state.listeners);
          listeners.delete(id);
          return { ...state, listeners };
        });
      }),
    );

  const shutdown: Effect.Effect<void> = Effect.gen(function* () {
    const flight = yield* Ref.modify(managerRef, (state) =>
      state.shutdown ? [undefined, state] : [state.flight, { shutdown: true }],
    );
    yield* Ref.update(publicationRef, (state) => ({
      ...state,
      snapshot: { ...copySnapshot(state.snapshot), loading: false },
      listeners: new Map(),
      closed: true,
    }));
    if (flight === undefined) {
      return;
    }
    yield* Deferred.interrupt(flight.deferred);
    if (flight.fiber !== undefined) {
      yield* Fiber.interrupt(flight.fiber);
    }
  });

  return { snapshot, refresh, subscribe, shutdown } satisfies HistoryIndexer;
});
