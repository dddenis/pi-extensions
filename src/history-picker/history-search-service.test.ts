import { describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Runtime,
  TestClock,
} from "effect";
import { expect } from "vitest";
import {
  HistorySearchEngine,
  type HistorySearchEngineService,
  type HistorySearchOutcome,
  type HistorySearchRequest,
  type PreparedHistoryCorpus,
} from "./history-search-engine";
import {
  makeHistorySearchService,
  makeHistorySearchServiceTest,
} from "./history-search-service";
import type { HistoryItem, HistorySearchSnapshot } from "./types";

interface PreparationCall {
  readonly items: ReadonlyArray<HistoryItem>;
  readonly completion: Deferred.Deferred<PreparedHistoryCorpus>;
}

interface SearchCall {
  readonly corpus: PreparedHistoryCorpus;
  readonly request: HistorySearchRequest;
  readonly completion: Deferred.Deferred<HistorySearchOutcome>;
}

interface ControlledHistorySearchEngineService {
  readonly takePreparation: Effect.Effect<PreparationCall>;
  readonly takeSearch: Effect.Effect<SearchCall>;
}

class ControlledHistorySearchEngine extends Context.Tag(
  "pi-extensions/ControlledHistorySearchEngine",
)<ControlledHistorySearchEngine, ControlledHistorySearchEngineService>() {}

interface ControlledHooks {
  readonly onPreparationInterrupt?: (call: PreparationCall) => void;
  readonly onPreparationInterruptEffect?: (
    call: PreparationCall,
  ) => Effect.Effect<void>;
  readonly onSearchInterrupt?: (call: SearchCall) => void;
  readonly onSearchInterruptEffect?: (call: SearchCall) => Effect.Effect<void>;
}

const makeControlledLayer = (hooks: ControlledHooks = {}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const preparations = yield* Queue.unbounded<PreparationCall>();
      const searches = yield* Queue.unbounded<SearchCall>();
      const controls: ControlledHistorySearchEngineService = {
        takePreparation: Queue.take(preparations),
        takeSearch: Queue.take(searches),
      };
      const engine: HistorySearchEngineService = {
        prepare: (items) =>
          Effect.gen(function* () {
            const completion = yield* Deferred.make<PreparedHistoryCorpus>();
            const call: PreparationCall = { items, completion };
            yield* Queue.offer(preparations, call);
            return yield* Deferred.await(completion).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => hooks.onPreparationInterrupt?.(call)).pipe(
                  Effect.zipRight(
                    hooks.onPreparationInterruptEffect?.(call) ?? Effect.void,
                  ),
                ),
              ),
            );
          }),
        search: (corpus, request) =>
          Effect.gen(function* () {
            const completion = yield* Deferred.make<HistorySearchOutcome>();
            const call: SearchCall = { corpus, request, completion };
            yield* Queue.offer(searches, call);
            return yield* Deferred.await(completion).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => hooks.onSearchInterrupt?.(call)).pipe(
                  Effect.zipRight(
                    hooks.onSearchInterruptEffect?.(call) ?? Effect.void,
                  ),
                ),
              ),
            );
          }),
      };
      return Context.make(ControlledHistorySearchEngine, controls).pipe(
        Context.add(HistorySearchEngine, engine),
      );
    }),
  );

const controlledLayer = makeControlledLayer();
const synchronousLayer = Layer.succeed(HistorySearchEngine, {
  prepare: () => Effect.succeed({ _tag: "PreparedHistoryCorpus" } as const),
  search: (_corpus, searchRequest) =>
    Effect.succeed(outcome(`sync ${searchRequest.query}`)),
} satisfies HistorySearchEngineService);
const controlledCorpus: PreparedHistoryCorpus = {
  _tag: "PreparedHistoryCorpus",
};

const item = (text: string, timestamp: number, cwd = "/a"): HistoryItem => ({
  text,
  timestamp,
  cwd,
  sessionFile: `/sessions/${timestamp}-${text.length}.jsonl`,
  source: "saved",
});

const outcome = (text: string): HistorySearchOutcome => ({
  results: [{ item: item(text, 1) }],
  hasMoreResults: false,
  fuzzySkippedForLongQuery: false,
});

const request = (
  query: string,
  scope: HistorySearchRequest["scope"] = "all",
): HistorySearchRequest => ({ query, scope, currentCwd: "/a" });

const completePreparation = (
  controls: ControlledHistorySearchEngineService,
  corpus: PreparedHistoryCorpus = controlledCorpus,
) =>
  Effect.gen(function* () {
    const preparation = yield* controls.takePreparation;
    yield* Deferred.succeed(preparation.completion, corpus);
    return preparation;
  });

const prepareService = (
  controls: ControlledHistorySearchEngineService,
  service: Effect.Effect.Success<typeof makeHistorySearchService>,
  items: ReadonlyArray<HistoryItem> = [item("alpha", 1)],
  corpus: PreparedHistoryCorpus = controlledCorpus,
) =>
  Effect.gen(function* () {
    yield* service.replaceItems(items);
    return yield* completePreparation(controls, corpus);
  });

describe("history search lifecycle service", () => {
  it.effect(
    "publishes searching only after 50ms and cancels it on completion",
    () =>
      Effect.gen(function* () {
        const controls = yield* ControlledHistorySearchEngine;
        const service = yield* makeHistorySearchService;
        const publications: boolean[] = [];
        const remove = yield* service.subscribe((snapshot) => {
          publications.push(snapshot.searching);
        });

        yield* service.search({
          query: "alpha",
          scope: "all",
          currentCwd: "/a",
        });
        yield* service.replaceItems([item("alpha", 1)]);
        const preparation = yield* controls.takePreparation;
        yield* Deferred.succeed(preparation.completion, controlledCorpus);
        const query = yield* controls.takeSearch;

        yield* TestClock.adjust("49 millis");
        expect(publications.at(-1)).toBe(false);
        yield* TestClock.adjust("1 millis");
        expect(publications.at(-1)).toBe(true);

        yield* Deferred.succeed(query.completion, outcome("alpha"));
        yield* Effect.yieldNow();
        expect(publications.at(-1)).toBe(false);
        yield* remove;
        yield* service.shutdown;
      }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect(
    "cancels the pending indicator when search completes before 50ms",
    () =>
      Effect.gen(function* () {
        const controls = yield* ControlledHistorySearchEngine;
        const service = yield* makeHistorySearchService;
        const publications: boolean[] = [];
        yield* service
          .subscribe((snapshot) => publications.push(snapshot.searching))
          .pipe(Effect.asVoid);
        yield* prepareService(controls, service);
        yield* service.search(request("fast"));
        const search = yield* controls.takeSearch;
        yield* Deferred.succeed(search.completion, outcome("fast"));
        yield* Effect.yieldNow();

        yield* TestClock.adjust("50 millis");
        expect(publications).not.toContain(true);
        expect((yield* service.snapshot).results[0]?.item.text).toBe("fast");
        yield* service.shutdown;
      }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect("interrupts query A and publishes only query B", () => {
    const interrupted: SearchCall[] = [];
    return Effect.gen(function* () {
      const controls = yield* ControlledHistorySearchEngine;
      const service = yield* makeHistorySearchService;
      const publishedResults: string[][] = [];
      yield* service
        .subscribe((snapshot) => {
          publishedResults.push(snapshot.results.map(({ item }) => item.text));
        })
        .pipe(Effect.asVoid);
      yield* prepareService(controls, service);

      yield* service.search(request("A"));
      const queryA = yield* controls.takeSearch;
      yield* service.search(request("B"));
      const queryB = yield* controls.takeSearch;
      expect(interrupted).toContain(queryA);

      yield* Deferred.succeed(queryA.completion, outcome("obsolete A"));
      yield* Effect.yieldNow();
      expect((yield* service.snapshot).results).toEqual([]);
      yield* Deferred.succeed(queryB.completion, outcome("current B"));
      yield* Effect.yieldNow();
      expect((yield* service.snapshot).results[0]?.item.text).toBe("current B");
      expect(publishedResults).not.toContainEqual(["obsolete A"]);
      yield* service.shutdown;
    }).pipe(
      Effect.provide(
        makeControlledLayer({
          onSearchInterrupt: (call) => interrupted.push(call),
        }),
      ),
    );
  });

  it.effect(
    "atomically retains prior results while replacing and reruns the latest query",
    () => {
      const interrupted: SearchCall[] = [];
      return Effect.gen(function* () {
        const controls = yield* ControlledHistorySearchEngine;
        const service = yield* makeHistorySearchService;
        const firstCorpus: PreparedHistoryCorpus = {
          _tag: "PreparedHistoryCorpus",
        };
        const nextCorpus: PreparedHistoryCorpus = {
          _tag: "PreparedHistoryCorpus",
        };
        yield* prepareService(
          controls,
          service,
          [item("prior", 1)],
          firstCorpus,
        );
        yield* service.search(request("prior"));
        const priorSearch = yield* controls.takeSearch;
        yield* Deferred.succeed(priorSearch.completion, outcome("prior"));
        yield* Effect.yieldNow();

        yield* service.search(request("latest"));
        const oldSearch = yield* controls.takeSearch;
        yield* service.replaceItems([item("replacement", 2)]);
        expect(interrupted).toContain(oldSearch);
        expect((yield* service.snapshot).results[0]?.item.text).toBe("prior");

        const preparation = yield* controls.takePreparation;
        yield* Deferred.succeed(preparation.completion, nextCorpus);
        const rerun = yield* controls.takeSearch;
        expect(rerun.corpus).toBe(nextCorpus);
        expect(rerun.request.query).toBe("latest");
        expect((yield* service.snapshot).results[0]?.item.text).toBe("prior");

        yield* Deferred.succeed(oldSearch.completion, outcome("obsolete"));
        yield* Deferred.succeed(rerun.completion, outcome("replacement"));
        yield* Effect.yieldNow();
        expect((yield* service.snapshot).results[0]?.item.text).toBe(
          "replacement",
        );
        yield* service.shutdown;
      }).pipe(
        Effect.provide(
          makeControlledLayer({
            onSearchInterrupt: (call) => interrupted.push(call),
          }),
        ),
      );
    },
  );

  it.effect(
    "interrupts an in-flight preparation when items are replaced",
    () => {
      const interrupted: PreparationCall[] = [];
      return Effect.gen(function* () {
        const controls = yield* ControlledHistorySearchEngine;
        const service = yield* makeHistorySearchService;
        yield* service.replaceItems([item("first", 1)]);
        const first = yield* controls.takePreparation;
        yield* service.replaceItems([item("second", 2)]);
        const second = yield* controls.takePreparation;

        expect(interrupted).toContain(first);
        yield* Deferred.succeed(first.completion, controlledCorpus);
        yield* Deferred.succeed(second.completion, controlledCorpus);
        yield* Effect.yieldNow();
        expect((yield* service.snapshot).warning).toBeUndefined();
        yield* service.shutdown;
      }).pipe(
        Effect.provide(
          makeControlledLayer({
            onPreparationInterrupt: (call) => interrupted.push(call),
          }),
        ),
      );
    },
  );

  it.effect(
    "reruns only the latest query after preparation without restarting it",
    () =>
      Effect.gen(function* () {
        const controls = yield* ControlledHistorySearchEngine;
        const service = yield* makeHistorySearchService;
        yield* service.search(request("A"));
        yield* service.replaceItems([item("entry", 1)]);
        const preparation = yield* controls.takePreparation;
        yield* service.search(request("B"));
        yield* service.search(request("C"));

        const extraPreparation = yield* Effect.fork(controls.takePreparation);
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(extraPreparation))).toBe(true);
        yield* Fiber.interrupt(extraPreparation);

        yield* Deferred.succeed(preparation.completion, controlledCorpus);
        const search = yield* controls.takeSearch;
        expect(search.request.query).toBe("C");
        const extraSearch = yield* Effect.fork(controls.takeSearch);
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(extraSearch))).toBe(true);
        yield* Fiber.interrupt(extraSearch);
        yield* service.shutdown;
      }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect(
    "does not prepare an identical ordered canonical item snapshot",
    () =>
      Effect.gen(function* () {
        const controls = yield* ControlledHistorySearchEngine;
        const service = yield* makeHistorySearchService;
        const original = [item("same", 1), item("same two", 2, "/b")];
        yield* service.replaceItems(original);
        const first = yield* controls.takePreparation;
        yield* service.replaceItems(original.map((entry) => ({ ...entry })));

        const secondTake = yield* Effect.fork(controls.takePreparation);
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(secondTake))).toBe(true);
        yield* Fiber.interrupt(secondTake);
        yield* Deferred.succeed(first.completion, controlledCorpus);
        yield* service.shutdown;
      }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect("prepares the initial empty item snapshot exactly once", () =>
    Effect.gen(function* () {
      const controls = yield* ControlledHistorySearchEngine;
      const service = yield* makeHistorySearchService;
      yield* service.replaceItems([]);
      const firstTake = yield* Effect.fork(controls.takePreparation);
      yield* Effect.yieldNow();
      expect(Option.isSome(yield* Fiber.poll(firstTake))).toBe(true);
      const first = yield* Fiber.join(firstTake);
      expect(first.items).toEqual([]);
      yield* service.replaceItems([]);

      const secondTake = yield* Effect.fork(controls.takePreparation);
      yield* Effect.yieldNow();
      expect(Option.isNone(yield* Fiber.poll(secondTake))).toBe(true);
      yield* Fiber.interrupt(firstTake);
      yield* Fiber.interrupt(secondTake);
      yield* service.shutdown;
    }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect("interrupts the previous search when scope changes", () => {
    const interrupted: SearchCall[] = [];
    return Effect.gen(function* () {
      const controls = yield* ControlledHistorySearchEngine;
      const service = yield* makeHistorySearchService;
      yield* prepareService(controls, service);
      yield* service.search(request("alpha", "all"));
      const allProjects = yield* controls.takeSearch;
      yield* service.search(request("alpha", "current-project"));
      const currentProject = yield* controls.takeSearch;
      expect(interrupted).toContain(allProjects);
      expect(currentProject.request.scope).toBe("current-project");
      yield* service.shutdown;
    }).pipe(
      Effect.provide(
        makeControlledLayer({
          onSearchInterrupt: (call) => interrupted.push(call),
        }),
      ),
    );
  });

  it.effect("publishes direct results with the fuzzy degradation warning", () =>
    Effect.gen(function* () {
      const controls = yield* ControlledHistorySearchEngine;
      const service = yield* makeHistorySearchService;
      yield* prepareService(controls, service);
      yield* service.search(request("alpha"));
      const search = yield* controls.takeSearch;
      yield* Deferred.succeed(search.completion, {
        ...outcome("direct alpha"),
        warning: "Fuzzy history search unavailable",
      });
      yield* Effect.yieldNow();

      const snapshot = yield* service.snapshot;
      expect(snapshot.results[0]?.item.text).toBe("direct alpha");
      expect(snapshot.warning).toBe("Fuzzy history search unavailable");
      yield* service.shutdown;
    }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect("retains prior results when search dies and warns once", () =>
    Effect.gen(function* () {
      const controls = yield* ControlledHistorySearchEngine;
      const service = yield* makeHistorySearchService;
      const warnings: Array<string | undefined> = [];
      yield* service
        .subscribe((snapshot) => warnings.push(snapshot.warning))
        .pipe(Effect.asVoid);
      yield* prepareService(controls, service);
      yield* service.search(request("prior"));
      const prior = yield* controls.takeSearch;
      yield* Deferred.succeed(prior.completion, outcome("prior"));
      yield* Effect.yieldNow();

      yield* service.search(request("defect"));
      const defect = yield* controls.takeSearch;
      yield* Deferred.die(defect.completion, new Error("search defect"));
      yield* Effect.yieldNow();

      const snapshot = yield* service.snapshot;
      expect(snapshot.results[0]?.item.text).toBe("prior");
      expect(snapshot.warning).toBe("History search unavailable");
      expect(
        warnings.filter((warning) => warning === "History search unavailable"),
      ).toHaveLength(1);
      yield* service.shutdown;
    }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect(
    "retains the prior corpus and results atomically when replacement preparation dies",
    () =>
      Effect.gen(function* () {
        const controls = yield* ControlledHistorySearchEngine;
        const service = yield* makeHistorySearchService;
        const warnings: Array<string | undefined> = [];
        yield* service
          .subscribe((snapshot) => warnings.push(snapshot.warning))
          .pipe(Effect.asVoid);
        const priorCorpus: PreparedHistoryCorpus = {
          _tag: "PreparedHistoryCorpus",
        };
        yield* prepareService(
          controls,
          service,
          [item("prior", 1)],
          priorCorpus,
        );
        yield* service.search(request("prior"));
        const prior = yield* controls.takeSearch;
        yield* Deferred.succeed(prior.completion, outcome("prior"));
        yield* Effect.yieldNow();

        yield* service.replaceItems([item("broken replacement", 2)]);
        const replacement = yield* controls.takePreparation;
        yield* Deferred.die(
          replacement.completion,
          new Error("preparation defect"),
        );
        yield* Effect.yieldNow();

        const retained = yield* service.snapshot;
        expect(retained.results[0]?.item.text).toBe("prior");
        expect(retained.warning).toBe("History search unavailable");
        expect(
          warnings.filter(
            (warning) => warning === "History search unavailable",
          ),
        ).toHaveLength(1);

        yield* service.search(request("still usable"));
        const retry = yield* controls.takeSearch;
        expect(retry.corpus).toBe(priorCorpus);
        yield* service.shutdown;
      }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect("does not warn when an obsolete request is interrupted", () => {
    const interrupted: SearchCall[] = [];
    return Effect.gen(function* () {
      const controls = yield* ControlledHistorySearchEngine;
      const service = yield* makeHistorySearchService;
      const warnings: string[] = [];
      yield* service
        .subscribe((snapshot) => {
          if (snapshot.warning !== undefined) warnings.push(snapshot.warning);
        })
        .pipe(Effect.asVoid);
      yield* prepareService(controls, service);
      yield* service.search(request("obsolete"));
      const obsolete = yield* controls.takeSearch;
      yield* service.search(request("current"));
      const current = yield* controls.takeSearch;
      expect(interrupted).toContain(obsolete);
      yield* Deferred.succeed(current.completion, outcome("current"));
      yield* Effect.yieldNow();
      expect(warnings).toEqual([]);
      yield* service.shutdown;
    }).pipe(
      Effect.provide(
        makeControlledLayer({
          onSearchInterrupt: (call) => interrupted.push(call),
        }),
      ),
    );
  });

  it.effect("owns synchronously completing startup work through cleanup", () =>
    Effect.gen(function* () {
      const service = yield* makeHistorySearchService;
      const publications: HistorySearchSnapshot[] = [];
      yield* service
        .subscribe((snapshot) => publications.push(snapshot))
        .pipe(Effect.asVoid);
      yield* service.search(request("immediate"));
      yield* service.replaceItems([item("immediate", 1)]);
      yield* Effect.yieldNow();
      yield* service.shutdown;
      yield* TestClock.adjust("50 millis");

      const snapshot = yield* service.snapshot;
      expect(snapshot.results[0]?.item.text).toBe("sync immediate");
      expect(snapshot.searching).toBe(false);
      expect(publications.at(-1)?.searching).toBe(false);
    }).pipe(Effect.provide(synchronousLayer)),
  );

  it.effect("makes concurrent shutdown callers await shared cleanup", () =>
    Effect.gen(function* () {
      const interruptStarted = yield* Deferred.make<void>();
      const allowInterrupt = yield* Deferred.make<void>();
      const layer = makeControlledLayer({
        onSearchInterruptEffect: () =>
          Deferred.succeed(interruptStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(allowInterrupt)),
          ),
      });
      const program = Effect.gen(function* () {
        const controls = yield* ControlledHistorySearchEngine;
        const service = yield* makeHistorySearchService;
        yield* prepareService(controls, service);
        yield* service.search(request("pending"));
        yield* controls.takeSearch;

        const first = yield* Effect.fork(service.shutdown);
        yield* Deferred.await(interruptStarted);
        const second = yield* Effect.fork(service.shutdown);
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(first))).toBe(true);
        expect(Option.isNone(yield* Fiber.poll(second))).toBe(true);

        yield* Deferred.succeed(allowInterrupt, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      });
      yield* program.pipe(Effect.provide(layer));
    }),
  );

  it.effect("skips an older queued delivery after a newer version wins", () =>
    Effect.gen(function* () {
      const captures = yield* Queue.unbounded<{
        readonly listenerIds: ReadonlyArray<number>;
        readonly version: number;
      }>();
      const deliveries = yield* Queue.unbounded<{
        readonly listenerId: number;
        readonly source: "initial" | "publication";
        readonly version: number;
        readonly proceed: Deferred.Deferred<void>;
      }>();
      const runtime = yield* Effect.runtime<never>();
      const service = yield* makeHistorySearchServiceTest({
        onPublicationCaptured: (capture) => Queue.offer(captures, capture),
        beforeDeliveryAcquire: (delivery) =>
          Effect.gen(function* () {
            const proceed = yield* Deferred.make<void>();
            yield* Queue.offer(deliveries, { ...delivery, proceed });
            yield* Deferred.await(proceed);
          }),
      });
      const controls = yield* ControlledHistorySearchEngine;
      yield* prepareService(controls, service);
      const delivered: string[] = [];
      const newerDelivered = yield* Deferred.make<void>();
      const subscription = yield* Effect.fork(
        service.subscribe((snapshot) => {
          const text = snapshot.results[0]?.item.text ?? "initial";
          delivered.push(text);
          if (text === "new") {
            Runtime.runSync(runtime)(
              Deferred.succeed(newerDelivered, undefined),
            );
          }
        }),
      );
      const initial = yield* Queue.take(deliveries);
      expect(initial.source).toBe("initial");
      yield* Deferred.succeed(initial.proceed, undefined);
      const remove = yield* Fiber.join(subscription);

      yield* service.search(request("old"));
      const oldSearch = yield* controls.takeSearch;
      yield* Deferred.succeed(oldSearch.completion, outcome("old"));
      const oldCapture = yield* Queue.take(captures);
      const oldDelivery = yield* Queue.take(deliveries);
      expect(oldDelivery.version).toBe(oldCapture.version);

      const newerRequest = yield* Effect.fork(service.search(request("new")));
      const newSearch = yield* controls.takeSearch;
      yield* Deferred.succeed(newSearch.completion, outcome("new"));
      const newCapture = yield* Queue.take(captures);
      const newDelivery = yield* Queue.take(deliveries);
      expect(newCapture.version).toBeGreaterThan(oldCapture.version);
      expect(newCapture.listenerIds).toEqual(oldCapture.listenerIds);

      yield* Deferred.succeed(newDelivery.proceed, undefined);
      yield* Deferred.await(newerDelivered);
      yield* Deferred.succeed(oldDelivery.proceed, undefined);
      yield* Fiber.join(newerRequest);
      yield* Effect.yieldNow();
      expect(delivered).toEqual(["initial", "new"]);
      yield* remove;
      yield* service.shutdown;
    }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect("suppresses a captured initial delivery after shutdown wins", () =>
    Effect.gen(function* () {
      const deliveries = yield* Queue.unbounded<{
        readonly source: "initial" | "publication";
        readonly proceed: Deferred.Deferred<void>;
      }>();
      const service = yield* makeHistorySearchServiceTest({
        beforeDeliveryAcquire: (delivery) =>
          Effect.gen(function* () {
            const proceed = yield* Deferred.make<void>();
            yield* Queue.offer(deliveries, {
              source: delivery.source,
              proceed,
            });
            yield* Deferred.await(proceed);
          }),
      });
      let callbackStarted = false;
      const subscription = yield* Effect.fork(
        service.subscribe(() => {
          callbackStarted = true;
        }),
      );
      const initial = yield* Queue.take(deliveries);
      expect(initial.source).toBe("initial");

      const shutdown = yield* Effect.fork(service.shutdown);
      yield* Fiber.join(shutdown);
      expect(Option.isNone(yield* Fiber.poll(subscription))).toBe(true);
      yield* Deferred.succeed(initial.proceed, undefined);
      yield* Fiber.join(subscription).pipe(Effect.asVoid);
      expect(callbackStarted).toBe(false);
    }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect(
    "removal waits for an active callback and suppresses its later captured delivery",
    () =>
      Effect.gen(function* () {
        const captures = yield* Queue.unbounded<{
          readonly listenerIds: ReadonlyArray<number>;
          readonly version: number;
        }>();
        const capturedDeliveries =
          yield* Queue.unbounded<Deferred.Deferred<void>>();
        const initialListenerIds: number[] = [];
        const capturedListener: { id: number | undefined } = { id: undefined };
        const runtime = yield* Effect.runtime<never>();
        const service = yield* makeHistorySearchServiceTest({
          onPublicationCaptured: (capture) => Queue.offer(captures, capture),
          beforeDeliveryAcquire: (delivery) => {
            if (delivery.source === "initial") {
              return Effect.sync(() => {
                initialListenerIds.push(delivery.listenerId);
              });
            }
            if (delivery.listenerId !== capturedListener.id) return Effect.void;
            return Effect.gen(function* () {
              const proceed = yield* Deferred.make<void>();
              yield* Queue.offer(capturedDeliveries, proceed);
              yield* Deferred.await(proceed);
            });
          },
        });
        const controls = yield* ControlledHistorySearchEngine;
        yield* prepareService(controls, service);
        let removeActive: Effect.Effect<void> = Effect.void;
        let removeCaptured: Effect.Effect<void> = Effect.void;
        const removalFibers: Array<Fiber.RuntimeFiber<void, never>> = [];
        const removalWasPending: boolean[] = [];
        let activeCallbacks = 0;
        let capturedCallbacks = 0;

        removeActive = yield* service.subscribe((snapshot) => {
          if (snapshot.results.length === 0) return;
          activeCallbacks += 1;
          const activeRemoval = Runtime.runFork(runtime)(removeActive);
          const capturedRemoval = Runtime.runFork(runtime)(removeCaptured);
          removalFibers.push(activeRemoval, capturedRemoval);
          removalWasPending.push(
            Option.isNone(Runtime.runSync(runtime)(Fiber.poll(activeRemoval))),
            Option.isNone(
              Runtime.runSync(runtime)(Fiber.poll(capturedRemoval)),
            ),
          );
        });
        removeCaptured = yield* service.subscribe((snapshot) => {
          if (snapshot.results.length > 0) capturedCallbacks += 1;
        });
        capturedListener.id = initialListenerIds[1];
        expect(capturedListener.id).toBeDefined();

        yield* service.search(request("publish"));
        const search = yield* controls.takeSearch;
        yield* Deferred.succeed(search.completion, outcome("publish"));
        const capture = yield* Queue.take(captures);
        expect(capture.listenerIds).toEqual(initialListenerIds);
        const capturedDelivery = yield* Queue.take(capturedDeliveries);
        yield* Effect.forEach(removalFibers, Fiber.join, { discard: true });
        yield* Deferred.succeed(capturedDelivery, undefined);
        yield* Effect.yieldNow();

        expect(activeCallbacks).toBe(1);
        expect(removalWasPending).toEqual([true, true]);
        expect(capturedCallbacks).toBe(0);
        yield* service.shutdown;
      }).pipe(Effect.provide(controlledLayer)),
  );

  it.effect(
    "shuts down idempotently, interrupts work, closes subscriptions, and makes later calls no-ops",
    () => {
      const interruptedPreparations: PreparationCall[] = [];
      const interruptedSearches: SearchCall[] = [];
      return Effect.gen(function* () {
        const controls = yield* ControlledHistorySearchEngine;
        const searchService = yield* makeHistorySearchService;
        const publications: HistorySearchSnapshot[] = [];
        yield* searchService
          .subscribe((snapshot) => publications.push(snapshot))
          .pipe(Effect.asVoid);
        yield* prepareService(controls, searchService);
        yield* searchService.search(request("pending"));
        const pendingSearch = yield* controls.takeSearch;

        yield* searchService.shutdown;
        yield* searchService.shutdown;
        expect(interruptedSearches).toContain(pendingSearch);
        const publicationCount = publications.length;
        yield* Deferred.succeed(pendingSearch.completion, outcome("late"));
        yield* searchService.search(request("later"));
        yield* searchService.replaceItems([item("later", 2)]);
        yield* TestClock.adjust("1 second");
        expect(publications).toHaveLength(publicationCount);
        expect((yield* searchService.snapshot).searching).toBe(false);

        const preparationService = yield* makeHistorySearchService;
        yield* preparationService.replaceItems([item("pending prep", 3)]);
        const pendingPreparation = yield* controls.takePreparation;
        yield* preparationService.shutdown;
        yield* preparationService.shutdown;
        expect(interruptedPreparations).toContain(pendingPreparation);

        let calledAfterShutdown = false;
        const remove = yield* preparationService.subscribe(() => {
          calledAfterShutdown = true;
        });
        yield* remove;
        expect(calledAfterShutdown).toBe(false);

        const unexpectedPreparation = yield* Effect.fork(
          controls.takePreparation,
        );
        const unexpectedSearch = yield* Effect.fork(controls.takeSearch);
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(unexpectedPreparation))).toBe(
          true,
        );
        expect(Option.isNone(yield* Fiber.poll(unexpectedSearch))).toBe(true);
        yield* Fiber.interrupt(unexpectedPreparation);
        yield* Fiber.interrupt(unexpectedSearch);
      }).pipe(
        Effect.provide(
          makeControlledLayer({
            onPreparationInterrupt: (call) =>
              interruptedPreparations.push(call),
            onSearchInterrupt: (call) => interruptedSearches.push(call),
          }),
        ),
      );
    },
  );

  it.effect("returns and publishes defensive snapshot copies", () =>
    Effect.gen(function* () {
      const controls = yield* ControlledHistorySearchEngine;
      const service = yield* makeHistorySearchService;
      let received: HistorySearchSnapshot | undefined;
      yield* service
        .subscribe((snapshot) => {
          received = snapshot;
        })
        .pipe(Effect.asVoid);
      yield* prepareService(controls, service);
      yield* service.search(request("copy"));
      const search = yield* controls.takeSearch;
      yield* Deferred.succeed(search.completion, outcome("copy"));
      yield* Effect.yieldNow();

      const first = yield* service.snapshot;
      const second = yield* service.snapshot;
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(first.results).not.toBe(second.results);
      expect(received).not.toBe(first);
      yield* service.shutdown;
    }).pipe(Effect.provide(controlledLayer)),
  );
});
