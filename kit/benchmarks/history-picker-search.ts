import { Cause, Deferred, Effect, Fiber, Runtime } from "effect";
import {
  HistorySearchEngine,
  makeHistorySearchEngineLayer,
  type HistorySearchBatchEvent,
  type HistorySearchEngineService,
  type HistorySearchOutcome,
  type HistorySearchRequest,
} from "../../src/history-picker/history-search-engine";
import { HISTORY_SEARCH_LIMITS } from "../../src/history-picker/history-search-normalization";
import {
  makeHistorySearchService,
  type HistorySearchService,
} from "../../src/history-picker/history-search-service";
import type {
  HistoryItem,
  HistorySearchSnapshot,
} from "../../src/history-picker/types";
import {
  adversarialFixture,
  observedCorpusFixture,
  oversizedPreparationFixture,
  shortPromptFixture,
} from "./history-picker-search-fixtures";

const request = (query: string): HistorySearchRequest => ({
  query,
  scope: "all",
  currentCwd: "/benchmark",
});

const fail = (message: string): Effect.Effect<never> =>
  Effect.die(new Error(message));

const assert = (condition: boolean, message: string): Effect.Effect<void> =>
  condition ? Effect.void : fail(message);

const measure = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const started = performance.now();
    const value = yield* effect;
    const elapsed = performance.now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      return yield* Effect.die(new Error(`${name} produced an invalid timing`));
    }
    console.log(`${name}: ${elapsed} ms`);
    return value;
  });

const validateEvidence = (
  name: string,
  outcome: HistorySearchOutcome,
): Effect.Effect<void> =>
  Effect.forEach(
    outcome.results,
    (result) => {
      const evidence = result.matchEvidence;
      if (result.matchTier === undefined || evidence === undefined) {
        return fail(`${name} published a result without match evidence`);
      }
      if (evidence.sourceRanges.length === 0) {
        return fail(`${name} published empty match evidence`);
      }
      const validRanges = evidence.sourceRanges.every(
        (range) =>
          Number.isInteger(range.start) &&
          Number.isInteger(range.end) &&
          range.start >= 0 &&
          range.start < range.end &&
          range.end <= result.item.text.length,
      );
      const validFocus =
        Number.isInteger(evidence.focusRange.start) &&
        Number.isInteger(evidence.focusRange.end) &&
        evidence.focusRange.start >= 0 &&
        evidence.focusRange.start < evidence.focusRange.end &&
        evidence.focusRange.end <= result.item.text.length;
      return assert(
        validRanges && validFocus,
        `${name} published out-of-range match evidence`,
      );
    },
    { discard: true },
  );

const isNeedlePublication = (snapshot: HistorySearchSnapshot): boolean =>
  !snapshot.searching &&
  snapshot.results.length === 1 &&
  snapshot.results[0]?.item.text.includes(" needle ") === true;

const publicationHangGuard = "30 seconds";

export const awaitBenchmarkPublication = (
  name: string,
  publication: Deferred.Deferred<void>,
): Effect.Effect<void> =>
  Deferred.await(publication).pipe(
    Effect.timeoutFailCause({
      duration: publicationHangGuard,
      onTimeout: () =>
        Cause.die(
          new Error(
            `${name} publication exceeded the 30-second benchmark hang guard`,
          ),
        ),
    }),
  );

const measureCancellation = (
  name: string,
  service: HistorySearchService,
  items: ReadonlyArray<HistoryItem>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const setupPublished = yield* Deferred.make<void>();
    const replacementPublished = yield* Deferred.make<void>();
    const terminalPublications: Array<HistorySearchSnapshot> = [];
    let measuring = false;

    const remove = yield* service.subscribe((snapshot) => {
      if (
        !measuring &&
        !snapshot.searching &&
        snapshot.results[0]?.item.text === "a".repeat(120_000)
      ) {
        Runtime.runSync(runtime)(Deferred.succeed(setupPublished, undefined));
      }
      if (!measuring) return;
      if (!snapshot.searching) terminalPublications.push(snapshot);
      if (isNeedlePublication(snapshot)) {
        Runtime.runSync(runtime)(
          Deferred.succeed(replacementPublished, undefined),
        );
      }
    });

    yield* Effect.gen(function* () {
      yield* service.replaceItems(items);
      yield* service.search(request("a".repeat(257)));
      yield* awaitBenchmarkPublication("setup", setupPublished);

      measuring = true;
      const started = performance.now();
      yield* service.search(request("a".repeat(256)));
      yield* Effect.yieldNow();
      yield* service.search(request("needle"));
      yield* awaitBenchmarkPublication("replacement", replacementPublished);
      const elapsed = performance.now() - started;

      yield* Effect.yieldNow();
      yield* assert(
        Number.isFinite(elapsed) && elapsed >= 0,
        `${name} produced an invalid timing`,
      );
      yield* assert(
        terminalPublications.length === 1,
        `${name} published a stale search generation`,
      );
      const replacement = terminalPublications[0];
      if (replacement === undefined || !isNeedlePublication(replacement)) {
        return yield* fail(`${name} did not publish the replacement query`);
      }
      const result = replacement.results[0];
      const focus = result?.matchEvidence?.focusRange;
      if (
        result === undefined ||
        focus === undefined ||
        result.item.text.slice(focus.start, focus.end) !== "needle"
      ) {
        return yield* fail(`${name} published invalid replacement evidence`);
      }
      console.log(`${name}: ${elapsed} ms`);
    }).pipe(Effect.ensuring(remove));
  });

const measureOversizedPreparation = (
  engine: HistorySearchEngineService,
  items: ReadonlyArray<HistoryItem>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const hostTurn = yield* Deferred.make<void>();
    let preparationCompleted = false;
    let heartbeatStopped = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let hostTurns = 0;
    let maximumHostLag = 0;
    const started = performance.now();
    let previousHostTurn = started;

    const scheduleHostTurn = (): void => {
      heartbeat = setTimeout(() => {
        const now = performance.now();
        maximumHostLag = Math.max(maximumHostLag, now - previousHostTurn);
        previousHostTurn = now;
        hostTurns += 1;
        Runtime.runSync(runtime)(Deferred.succeed(hostTurn, undefined));
        if (!heartbeatStopped) scheduleHostTurn();
      }, 0);
    };
    scheduleHostTurn();

    const preparation = yield* Effect.fork(
      engine.prepare(items).pipe(
        Effect.tap(
          Effect.sync(() => {
            preparationCompleted = true;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            heartbeatStopped = true;
            if (heartbeat !== undefined && hostTurns > 0) {
              clearTimeout(heartbeat);
            }
          }),
        ),
      ),
    );
    yield* Deferred.await(hostTurn);
    yield* assert(
      !preparationCompleted,
      "prepare-oversized blocked the host event loop until completion",
    );
    yield* Fiber.join(preparation);
    yield* assert(
      hostTurns > 1,
      "prepare-oversized did not yield repeatedly to the host event loop",
    );

    console.log(
      `prepare-oversized-host-cooperative: ${performance.now() - started} ms (${hostTurns} host turns, ${maximumHostLag} ms maximum lag)`,
    );
  });

const validateBatchBounds = (
  events: ReadonlyArray<HistorySearchBatchEvent>,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    yield* assert(events.length > 0, "history benchmark observed no batches");
    yield* assert(
      events.some((event) => event.phase === "prepare-fuzzy") &&
        events.some((event) => event.phase === "direct") &&
        events.some((event) => event.phase === "fuzzy"),
      "history benchmark did not observe every batch phase",
    );

    let maximumElapsed = 0;
    for (const event of events) {
      yield* assert(
        event.size > 0 && event.size <= HISTORY_SEARCH_LIMITS.batchSize,
        `history benchmark exceeded the ${HISTORY_SEARCH_LIMITS.batchSize}-item batch limit`,
      );
      yield* assert(
        event.maximumTargetCodeUnits === undefined ||
          event.maximumTargetCodeUnits <=
            HISTORY_SEARCH_LIMITS.segmentCodeUnits,
        `history benchmark exceeded the ${HISTORY_SEARCH_LIMITS.segmentCodeUnits}-unit target limit`,
      );
      yield* assert(
        event.maximumQueryCodeUnits === undefined ||
          event.maximumQueryCodeUnits <=
            HISTORY_SEARCH_LIMITS.fuzzyQueryCodeUnits,
        `history benchmark exceeded the ${HISTORY_SEARCH_LIMITS.fuzzyQueryCodeUnits}-unit query limit`,
      );
      yield* assert(
        Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0,
        "history benchmark observed an invalid batch timing",
      );
      if (event.phase !== "prepare-record") {
        maximumElapsed = Math.max(maximumElapsed, event.elapsedMs);
      }
    }
    return maximumElapsed;
  });

const batches: Array<HistorySearchBatchEvent> = [];
const engineLayer = makeHistorySearchEngineLayer((event) => {
  batches.push(event);
});

const benchmark = Effect.gen(function* () {
  const engine = yield* HistorySearchEngine;
  const service = yield* makeHistorySearchService;
  const observed = observedCorpusFixture();
  const oversized = oversizedPreparationFixture();
  const shortPrompts = shortPromptFixture();
  const adversarial = adversarialFixture();

  yield* Effect.gen(function* () {
    const warmCorpus = yield* engine.prepare(shortPrompts.slice(0, 64));
    yield* engine.search(warmCorpus, request("blue widget"));
  });
  batches.length = 0;

  yield* Effect.gen(function* () {
    const corpus = yield* measure("prepare-observed", engine.prepare(observed));
    yield* measureOversizedPreparation(engine, oversized);
    const shortPromptCorpus = yield* measure(
      "prepare-short-prompts",
      engine.prepare(shortPrompts),
    );
    const ordinary = yield* measure(
      "query-ordinary",
      engine.search(shortPromptCorpus, request("blue widget")),
    );
    yield* assert(
      ordinary.results.length === HISTORY_SEARCH_LIMITS.resultLimit &&
        ordinary.hasMoreResults,
      "query-ordinary did not return the capped matching result set",
    );
    yield* validateEvidence("query-ordinary", ordinary);

    const atLimit = yield* measure(
      "query-256",
      engine.search(corpus, request("a".repeat(256))),
    );
    yield* assert(
      !atLimit.fuzzySkippedForLongQuery,
      "query-256 unexpectedly skipped fuzzy search",
    );
    yield* validateEvidence("query-256", atLimit);

    const eventCountBeforeLongQuery = batches.length;
    const overLimit = yield* measure(
      "query-257-direct-only",
      engine.search(corpus, request("a".repeat(257))),
    );
    const longQueryEvents = batches.slice(eventCountBeforeLongQuery);
    yield* assert(
      overLimit.fuzzySkippedForLongQuery &&
        !longQueryEvents.some((event) => event.phase === "fuzzy"),
      "query-257-direct-only did not use direct-only search",
    );
    const adversarialDirectMatch = overLimit.results.find(
      (result) => result.item.text.length === 119_732,
    );
    yield* assert(
      adversarialDirectMatch?.matchTier === "substring" &&
        adversarialDirectMatch.matchEvidence?.focusRange.start === 1 &&
        adversarialDirectMatch.matchEvidence.focusRange.end === 258,
      "query-257-direct-only did not inspect repeated non-boundary occurrences",
    );
    yield* validateEvidence("query-257-direct-only", overLimit);

    yield* measureCancellation("cancel-adversarial", service, adversarial);
    const maximumBatch = yield* validateBatchBounds(batches);
    console.log(`maximum-observed-synchronous-batch: ${maximumBatch} ms`);
  }).pipe(Effect.ensuring(service.shutdown));
}).pipe(Effect.provide(engineLayer));

if (import.meta.main) {
  await Effect.runPromise(benchmark);
}
