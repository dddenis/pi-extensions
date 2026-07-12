import { Cause, Deferred, Effect, Exit, Fiber, Ref } from "effect";
import {
  HistorySearchEngine,
  type HistorySearchOutcome,
  type HistorySearchRequest,
  type PreparedHistoryCorpus,
} from "./history-search-engine";
import type {
  HistoryItem,
  HistorySearchResult,
  HistorySearchSnapshot,
} from "./types";

export interface HistorySearchService {
  readonly snapshot: Effect.Effect<HistorySearchSnapshot>;
  readonly replaceItems: (
    items: ReadonlyArray<HistoryItem>,
  ) => Effect.Effect<void>;
  readonly search: (request: HistorySearchRequest) => Effect.Effect<void>;
  readonly subscribe: (
    listener: (snapshot: HistorySearchSnapshot) => void,
  ) => Effect.Effect<Effect.Effect<void>>;
  readonly shutdown: Effect.Effect<void>;
}

export interface HistorySearchDeliveryTestEvent {
  readonly listenerId: number;
  readonly source: "initial" | "publication";
  readonly version: number;
}

export interface HistorySearchPublicationTestEvent {
  readonly listenerIds: ReadonlyArray<number>;
  readonly version: number;
}

export interface HistorySearchServiceTestHooks {
  readonly beforeDeliveryAcquire?: (
    event: HistorySearchDeliveryTestEvent,
  ) => Effect.Effect<void>;
  readonly onPublicationCaptured?: (
    event: HistorySearchPublicationTestEvent,
  ) => Effect.Effect<void>;
}

type SnapshotListener = (snapshot: HistorySearchSnapshot) => void;
type WorkerFiber = Fiber.Fiber<void, never>;

interface WorkerSlot {
  readonly fiber: Deferred.Deferred<WorkerFiber>;
}

interface ListenerRegistration {
  readonly listener: SnapshotListener;
  readonly deliveredVersion: number;
}

interface ManagerState {
  readonly corpusGeneration: number;
  readonly queryGeneration: number;
  readonly items: ReadonlyArray<HistoryItem> | undefined;
  readonly request: HistorySearchRequest | undefined;
  readonly corpus: PreparedHistoryCorpus | undefined;
  readonly preparation: WorkerSlot | undefined;
  readonly preparing: boolean;
  readonly search: WorkerSlot | undefined;
  readonly indicator: WorkerSlot | undefined;
  readonly listeners: ReadonlyMap<number, ListenerRegistration>;
  readonly nextListenerId: number;
  readonly snapshot: HistorySearchSnapshot;
  readonly snapshotVersion: number;
  readonly closed: boolean;
}

interface Publication {
  readonly listenerIds: ReadonlyArray<number>;
  readonly snapshot: HistorySearchSnapshot;
  readonly version: number;
}

interface SearchTransition {
  readonly corpusGeneration: number;
  readonly queryGeneration: number;
  readonly corpus: PreparedHistoryCorpus | undefined;
  readonly oldSearch: WorkerSlot | undefined;
  readonly oldIndicator: WorkerSlot | undefined;
}

interface ReplacementTransition {
  readonly corpusGeneration: number;
  readonly queryGeneration: number;
  readonly request: HistorySearchRequest | undefined;
  readonly oldPreparation: WorkerSlot | undefined;
  readonly oldSearch: WorkerSlot | undefined;
  readonly oldIndicator: WorkerSlot | undefined;
}

interface PreparedTransition {
  readonly queryGeneration: number;
  readonly request: HistorySearchRequest | undefined;
}

interface TerminalPublication {
  readonly indicator: WorkerSlot | undefined;
  readonly publication: Publication;
}

const unavailableWarning = "History search unavailable";

const copyItem = (item: HistoryItem): HistoryItem => ({
  text: item.text,
  timestamp: item.timestamp,
  sessionFile: item.sessionFile,
  cwd: item.cwd,
  source: item.source,
});

const copyRequest = (request: HistorySearchRequest): HistorySearchRequest => ({
  query: request.query,
  scope: request.scope,
  currentCwd: request.currentCwd,
});

const copyResult = (result: HistorySearchResult): HistorySearchResult => ({
  item: copyItem(result.item),
  ...(result.matchTier === undefined ? {} : { matchTier: result.matchTier }),
  ...(result.matchEvidence === undefined
    ? {}
    : {
        matchEvidence: {
          sourceRanges: result.matchEvidence.sourceRanges.map((range) => ({
            start: range.start,
            end: range.end,
          })),
          focusRange: {
            start: result.matchEvidence.focusRange.start,
            end: result.matchEvidence.focusRange.end,
          },
        },
      }),
});

const copySnapshot = (
  snapshot: HistorySearchSnapshot,
): HistorySearchSnapshot => ({
  results: snapshot.results.map(copyResult),
  hasMoreResults: snapshot.hasMoreResults,
  searching: snapshot.searching,
  ...(snapshot.warning === undefined ? {} : { warning: snapshot.warning }),
});

const sameItem = (left: HistoryItem, right: HistoryItem): boolean =>
  left.text === right.text &&
  left.timestamp === right.timestamp &&
  left.sessionFile === right.sessionFile &&
  left.cwd === right.cwd &&
  left.source === right.source;

const sameItems = (
  left: ReadonlyArray<HistoryItem>,
  right: ReadonlyArray<HistoryItem>,
): boolean =>
  left.length === right.length &&
  left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined && sameItem(entry, candidate);
  });

const makePublication = (
  state: ManagerState,
  snapshot: HistorySearchSnapshot,
): Publication => ({
  listenerIds: [...state.listeners.keys()],
  snapshot,
  version: state.snapshotVersion + 1,
});

const makeHistorySearchServiceWithHooks = Effect.fnUntraced(function* (
  hooks: HistorySearchServiceTestHooks,
) {
  const engine = yield* HistorySearchEngine;
  const shutdownComplete = yield* Deferred.make<void>();
  const deliveryLock = yield* Effect.makeSemaphore(1);
  const stateRef = yield* Ref.make<ManagerState>({
    corpusGeneration: 0,
    queryGeneration: 0,
    items: undefined,
    request: undefined,
    corpus: undefined,
    preparation: undefined,
    preparing: false,
    search: undefined,
    indicator: undefined,
    listeners: new Map(),
    nextListenerId: 0,
    snapshot: { results: [], hasMoreResults: false, searching: false },
    snapshotVersion: 0,
    closed: false,
  });

  const makeWorkerSlot = (): Effect.Effect<WorkerSlot> =>
    Deferred.make<WorkerFiber>().pipe(Effect.map((fiber) => ({ fiber })));

  const launch = (
    slot: WorkerSlot,
    worker: Effect.Effect<void>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkDaemon(Effect.interruptible(worker));
      yield* Deferred.succeed(slot.fiber, fiber);
    });

  const interrupt = (slot: WorkerSlot | undefined): Effect.Effect<void> =>
    slot === undefined
      ? Effect.void
      : Deferred.await(slot.fiber).pipe(
          Effect.flatMap(Fiber.interrupt),
          Effect.asVoid,
        );

  const deliver = (
    listenerId: number,
    version: number,
    snapshot: HistorySearchSnapshot,
    source: HistorySearchDeliveryTestEvent["source"],
  ): Effect.Effect<void> =>
    (
      hooks.beforeDeliveryAcquire?.({ listenerId, source, version }) ??
      Effect.void
    ).pipe(
      Effect.zipRight(
        deliveryLock.withPermits(1)(
          Ref.modify<ManagerState, SnapshotListener | undefined>(
            stateRef,
            (state) => {
              const registration = state.listeners.get(listenerId);
              if (
                state.closed ||
                registration === undefined ||
                registration.deliveredVersion >= version
              ) {
                return [undefined, state];
              }
              const listeners = new Map(state.listeners);
              listeners.set(listenerId, {
                ...registration,
                deliveredVersion: version,
              });
              return [registration.listener, { ...state, listeners }];
            },
          ).pipe(
            Effect.flatMap((listener) =>
              listener === undefined
                ? Effect.void
                : Effect.sync(() => listener(copySnapshot(snapshot))).pipe(
                    Effect.catchAllCause(() => Effect.void),
                  ),
            ),
          ),
        ),
      ),
    );

  const deliverPublication = (
    publication: Publication | undefined,
  ): Effect.Effect<void> =>
    publication === undefined
      ? Effect.void
      : (
          hooks.onPublicationCaptured?.({
            listenerIds: [...publication.listenerIds],
            version: publication.version,
          }) ?? Effect.void
        ).pipe(
          Effect.zipRight(
            Effect.forEach(
              publication.listenerIds,
              (listenerId) =>
                deliver(
                  listenerId,
                  publication.version,
                  publication.snapshot,
                  "publication",
                ),
              { discard: true },
            ),
          ),
        );

  const clearIndicator = (slot: WorkerSlot): Effect.Effect<void> =>
    Ref.update(stateRef, (state) =>
      state.indicator === slot ? { ...state, indicator: undefined } : state,
    );

  const clearSearch = (slot: WorkerSlot): Effect.Effect<void> =>
    Ref.update(stateRef, (state) =>
      state.search === slot ? { ...state, search: undefined } : state,
    );

  const clearPreparation = (slot: WorkerSlot): Effect.Effect<void> =>
    Ref.update(stateRef, (state) =>
      state.preparation === slot ? { ...state, preparation: undefined } : state,
    );

  const publishSearching = (
    slot: WorkerSlot,
    corpusGeneration: number,
    queryGeneration: number,
  ): Effect.Effect<void> =>
    Ref.modify<ManagerState, Publication | undefined>(stateRef, (state) => {
      if (
        state.closed ||
        state.corpusGeneration !== corpusGeneration ||
        state.queryGeneration !== queryGeneration ||
        state.indicator !== slot ||
        state.snapshot.searching
      ) {
        return [undefined, state];
      }
      const snapshot = copySnapshot({ ...state.snapshot, searching: true });
      const publication = makePublication(state, snapshot);
      return [
        publication,
        {
          ...state,
          snapshot,
          snapshotVersion: publication.version,
        },
      ];
    }).pipe(Effect.flatMap(deliverPublication));

  const launchIndicator = (
    slot: WorkerSlot,
    corpusGeneration: number,
    queryGeneration: number,
  ): Effect.Effect<void> =>
    launch(
      slot,
      Effect.sleep("50 millis").pipe(
        Effect.zipRight(
          publishSearching(slot, corpusGeneration, queryGeneration),
        ),
        Effect.ensuring(clearIndicator(slot)),
      ),
    );

  const completeSearch = (
    slot: WorkerSlot,
    corpusGeneration: number,
    queryGeneration: number,
    exit: Exit.Exit<HistorySearchOutcome, never>,
  ): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const terminal = yield* Ref.modify<
          ManagerState,
          TerminalPublication | undefined
        >(stateRef, (state) => {
          if (
            state.closed ||
            state.corpusGeneration !== corpusGeneration ||
            state.queryGeneration !== queryGeneration ||
            state.search !== slot
          ) {
            return [undefined, state];
          }
          if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)) {
            return [undefined, state];
          }
          const snapshot: HistorySearchSnapshot = Exit.isSuccess(exit)
            ? {
                results: exit.value.results.map(copyResult),
                hasMoreResults: exit.value.hasMoreResults,
                searching: false,
                ...(exit.value.warning === undefined
                  ? {}
                  : { warning: exit.value.warning }),
              }
            : {
                ...copySnapshot(state.snapshot),
                searching: false,
                warning: unavailableWarning,
              };
          const copied = copySnapshot(snapshot);
          const publication = makePublication(state, copied);
          return [
            { indicator: state.indicator, publication },
            {
              ...state,
              indicator: undefined,
              snapshot: copied,
              snapshotVersion: publication.version,
            },
          ];
        });
        if (terminal !== undefined) {
          yield* deliverPublication(terminal.publication);
          yield* interrupt(terminal.indicator);
        }
        yield* clearSearch(slot);
      }),
    );

  const launchSearch = (
    slot: WorkerSlot,
    corpusGeneration: number,
    queryGeneration: number,
    corpus: PreparedHistoryCorpus,
    request: HistorySearchRequest,
  ): Effect.Effect<void> =>
    launch(
      slot,
      engine.search(corpus, request).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          completeSearch(slot, corpusGeneration, queryGeneration, exit),
        ),
        Effect.ensuring(clearSearch(slot)),
      ),
    );

  const publishPreparationFailure = (
    slot: WorkerSlot,
    corpusGeneration: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const terminal = yield* Ref.modify<
        ManagerState,
        TerminalPublication | undefined
      >(stateRef, (state) => {
        if (
          state.closed ||
          state.corpusGeneration !== corpusGeneration ||
          state.preparation !== slot
        ) {
          return [undefined, state];
        }
        const snapshot = copySnapshot({
          ...state.snapshot,
          searching: false,
          warning: unavailableWarning,
        });
        const publication = makePublication(state, snapshot);
        return [
          { indicator: state.indicator, publication },
          {
            ...state,
            preparing: false,
            indicator: undefined,
            snapshot,
            snapshotVersion: publication.version,
          },
        ];
      });
      if (terminal !== undefined) {
        yield* deliverPublication(terminal.publication);
        yield* interrupt(terminal.indicator);
      }
      yield* clearPreparation(slot);
    });

  const completePreparation = (
    slot: WorkerSlot,
    corpusGeneration: number,
    exit: Exit.Exit<PreparedHistoryCorpus, never>,
  ): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (Exit.isFailure(exit)) {
          if (Cause.isInterruptedOnly(exit.cause)) {
            yield* clearPreparation(slot);
          } else {
            yield* publishPreparationFailure(slot, corpusGeneration);
          }
          return;
        }

        const searchSlot = yield* makeWorkerSlot();
        const transition = yield* Ref.modify<
          ManagerState,
          PreparedTransition | undefined
        >(stateRef, (state) => {
          if (
            state.closed ||
            state.corpusGeneration !== corpusGeneration ||
            state.preparation !== slot
          ) {
            return [undefined, state];
          }
          return [
            {
              queryGeneration: state.queryGeneration,
              request: state.request,
            },
            {
              ...state,
              corpus: exit.value,
              preparation: undefined,
              preparing: false,
              search: state.request === undefined ? undefined : searchSlot,
            },
          ];
        });
        if (transition?.request !== undefined) {
          yield* launchSearch(
            searchSlot,
            corpusGeneration,
            transition.queryGeneration,
            exit.value,
            transition.request,
          );
        }
        yield* clearPreparation(slot);
      }),
    );

  const launchPreparation = (
    slot: WorkerSlot,
    corpusGeneration: number,
    items: ReadonlyArray<HistoryItem>,
  ): Effect.Effect<void> =>
    launch(
      slot,
      engine.prepare(items).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          completePreparation(slot, corpusGeneration, exit),
        ),
        Effect.ensuring(clearPreparation(slot)),
      ),
    );

  const snapshot: Effect.Effect<HistorySearchSnapshot> = Ref.get(stateRef).pipe(
    Effect.map((state) => copySnapshot(state.snapshot)),
  );

  const search = (requested: HistorySearchRequest): Effect.Effect<void> =>
    Effect.suspend(() =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const copiedRequest = copyRequest(requested);
          const indicatorSlot = yield* makeWorkerSlot();
          const searchSlot = yield* makeWorkerSlot();
          const transition = yield* Ref.modify<
            ManagerState,
            SearchTransition | undefined
          >(stateRef, (state) => {
            if (state.closed) return [undefined, state];
            const queryGeneration = state.queryGeneration + 1;
            const corpus = state.preparing ? undefined : state.corpus;
            return [
              {
                corpusGeneration: state.corpusGeneration,
                queryGeneration,
                corpus,
                oldSearch: state.search,
                oldIndicator: state.indicator,
              },
              {
                ...state,
                queryGeneration,
                request: copiedRequest,
                search: corpus === undefined ? undefined : searchSlot,
                indicator: indicatorSlot,
              },
            ];
          });
          if (transition === undefined) return;

          yield* launchIndicator(
            indicatorSlot,
            transition.corpusGeneration,
            transition.queryGeneration,
          );
          if (transition.corpus !== undefined) {
            yield* launchSearch(
              searchSlot,
              transition.corpusGeneration,
              transition.queryGeneration,
              transition.corpus,
              copiedRequest,
            );
          }
          yield* interrupt(transition.oldSearch);
          yield* interrupt(transition.oldIndicator);
        }),
      ),
    );

  const replaceItems = (
    replacement: ReadonlyArray<HistoryItem>,
  ): Effect.Effect<void> =>
    Effect.suspend(() =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const items = replacement.map(copyItem);
          const preparationSlot = yield* makeWorkerSlot();
          const indicatorSlot = yield* makeWorkerSlot();
          const transition = yield* Ref.modify<
            ManagerState,
            ReplacementTransition | undefined
          >(stateRef, (state) => {
            if (
              state.closed ||
              (state.items !== undefined && sameItems(state.items, items))
            ) {
              return [undefined, state];
            }
            const corpusGeneration = state.corpusGeneration + 1;
            return [
              {
                corpusGeneration,
                queryGeneration: state.queryGeneration,
                request: state.request,
                oldPreparation: state.preparation,
                oldSearch: state.search,
                oldIndicator: state.indicator,
              },
              {
                ...state,
                corpusGeneration,
                items,
                preparation: preparationSlot,
                preparing: true,
                search: undefined,
                indicator:
                  state.request === undefined ? undefined : indicatorSlot,
              },
            ];
          });
          if (transition === undefined) return;

          if (transition.request !== undefined) {
            yield* launchIndicator(
              indicatorSlot,
              transition.corpusGeneration,
              transition.queryGeneration,
            );
          }
          yield* launchPreparation(
            preparationSlot,
            transition.corpusGeneration,
            items,
          );
          yield* interrupt(transition.oldPreparation);
          yield* interrupt(transition.oldSearch);
          yield* interrupt(transition.oldIndicator);
        }),
      ),
    );

  const subscribe = (
    listener: SnapshotListener,
  ): Effect.Effect<Effect.Effect<void>> =>
    Ref.modify<
      ManagerState,
      | {
          readonly id: number;
          readonly snapshot: HistorySearchSnapshot;
          readonly version: number;
        }
      | undefined
    >(stateRef, (state) => {
      if (state.closed) return [undefined, state];
      const id = state.nextListenerId;
      const listeners = new Map(state.listeners);
      listeners.set(id, { listener, deliveredVersion: -1 });
      return [
        {
          id,
          snapshot: copySnapshot(state.snapshot),
          version: state.snapshotVersion,
        },
        { ...state, listeners, nextListenerId: id + 1 },
      ];
    }).pipe(
      Effect.flatMap((registration) => {
        if (registration === undefined) return Effect.succeed(Effect.void);
        const remove = deliveryLock.withPermits(1)(
          Ref.update(stateRef, (state) => {
            if (!state.listeners.has(registration.id)) return state;
            const listeners = new Map(state.listeners);
            listeners.delete(registration.id);
            return { ...state, listeners };
          }),
        );
        return deliver(
          registration.id,
          registration.version,
          registration.snapshot,
          "initial",
        ).pipe(Effect.as(remove));
      }),
    );

  const shutdown: Effect.Effect<void> = Effect.uninterruptible(
    Effect.gen(function* () {
      const owned = yield* deliveryLock.withPermits(1)(
        Ref.modify<
          ManagerState,
          | {
              readonly _tag: "Lead";
              readonly slots: ReadonlyArray<WorkerSlot | undefined>;
            }
          | { readonly _tag: "Follow" }
        >(stateRef, (state) => {
          if (state.closed) return [{ _tag: "Follow" }, state];
          return [
            {
              _tag: "Lead",
              slots: [state.preparation, state.search, state.indicator],
            },
            {
              ...state,
              preparation: undefined,
              preparing: false,
              search: undefined,
              indicator: undefined,
              listeners: new Map(),
              snapshot: copySnapshot({ ...state.snapshot, searching: false }),
              closed: true,
            },
          ];
        }),
      );
      if (owned._tag === "Follow") {
        yield* Deferred.await(shutdownComplete);
        return;
      }
      yield* Effect.forEach(owned.slots, interrupt, { discard: true });
      yield* Deferred.succeed(shutdownComplete, undefined);
    }),
  );

  return {
    snapshot,
    replaceItems,
    search,
    subscribe,
    shutdown,
  } satisfies HistorySearchService;
});

export const makeHistorySearchServiceTest = (
  hooks: HistorySearchServiceTestHooks,
): Effect.Effect<HistorySearchService, never, HistorySearchEngine> =>
  makeHistorySearchServiceWithHooks(hooks);

export const makeHistorySearchService: Effect.Effect<
  HistorySearchService,
  never,
  HistorySearchEngine
> = makeHistorySearchServiceWithHooks({});
