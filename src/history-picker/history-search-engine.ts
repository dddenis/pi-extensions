import { Context, Effect, Either, Layer } from "effect";
import {
  compareRankedCandidates,
  compareSameMessageFuzzyEvidence,
  findDirectMatch,
  findFuzzyBatchMatches,
  prepareFuzzyBatch,
  prepareHistoryRecordCooperatively,
  type PreparedFuzzyBatch,
  type PreparedHistoryRecord,
  type RankedHistoryCandidate,
} from "./history-search-adapter";
import {
  HISTORY_SEARCH_LIMITS,
  makeHistorySearchCheckpoint,
  normalizeHistorySearchText,
} from "./history-search-normalization";
import type { HistoryItem, HistoryScope, HistorySearchResult } from "./types";

export interface HistorySearchRequest {
  readonly query: string;
  readonly scope: HistoryScope;
  readonly currentCwd: string;
}

export interface HistorySearchOutcome {
  readonly results: ReadonlyArray<HistorySearchResult>;
  readonly hasMoreResults: boolean;
  readonly fuzzySkippedForLongQuery: boolean;
  readonly warning?: string;
}

export interface PreparedHistoryCorpus {
  readonly _tag: "PreparedHistoryCorpus";
}

export interface HistorySearchEngineService {
  readonly prepare: (
    items: ReadonlyArray<HistoryItem>,
  ) => Effect.Effect<PreparedHistoryCorpus>;
  readonly search: (
    corpus: PreparedHistoryCorpus,
    request: HistorySearchRequest,
  ) => Effect.Effect<HistorySearchOutcome>;
}

export interface HistorySearchBatchEvent {
  readonly phase: "prepare-record" | "prepare-fuzzy" | "direct" | "fuzzy";
  readonly size: number;
  readonly maximumTargetCodeUnits?: number;
  readonly maximumQueryCodeUnits?: number;
  readonly elapsedMs: number;
}

export type HistorySearchBatchObserver = (
  event: HistorySearchBatchEvent,
) => void;

export interface HistorySearchEngineTestHooks {
  readonly observer?: HistorySearchBatchObserver;
  readonly beforeFuzzyBatch?: (batchIndex: number) => void;
  readonly onEligibilityBatch?: (size: number) => void;
  readonly onEmptyQueryBatch?: (size: number) => void;
}

interface InternalHistoryCorpus {
  readonly records: ReadonlyArray<PreparedHistoryRecord>;
  readonly fuzzyBatches: ReadonlyArray<PreparedFuzzyBatch>;
}

interface EligibleHistoryRecords {
  readonly records: ReadonlyArray<PreparedHistoryRecord>;
  readonly recordIds: ReadonlySet<number>;
}

interface BoundedCandidateCollector {
  readonly offerDirect: (candidate: RankedHistoryCandidate) => void;
  readonly offerFuzzy: (candidate: RankedHistoryCandidate) => void;
  readonly discardFuzzy: () => void;
  readonly finish: (
    warning: string | undefined,
    fuzzySkippedForLongQuery: boolean,
  ) => HistorySearchOutcome;
}

const internalCorpora = new WeakMap<
  PreparedHistoryCorpus,
  InternalHistoryCorpus
>();

const elapsedSince = (started: number): number => performance.now() - started;

const maximumSegmentLength = (batch: PreparedFuzzyBatch): number => {
  const metadata = internalBatchMaximumTarget.get(batch);
  return metadata ?? 0;
};

const internalBatchMaximumTarget = new WeakMap<PreparedFuzzyBatch, number>();

const prepareCorpus = (
  items: ReadonlyArray<HistoryItem>,
  observer: HistorySearchBatchObserver | undefined,
): Effect.Effect<PreparedHistoryCorpus> =>
  Effect.gen(function* () {
    const records: Array<PreparedHistoryRecord> = [];
    const fuzzyBatches: Array<PreparedFuzzyBatch> = [];
    const checkpoint = makeHistorySearchCheckpoint();
    let pendingSegments: Array<PreparedHistoryRecord["segments"][number]> = [];
    let recordsWithoutSegments = 0;

    const flushFuzzyBatch = (
      segments: ReadonlyArray<(typeof pendingSegments)[number]>,
    ) => {
      const started = observer === undefined ? 0 : performance.now();
      const batch = prepareFuzzyBatch(segments);
      const maximumTargetCodeUnits = segments.reduce(
        (maximum, segment) => Math.max(maximum, segment.text.length),
        0,
      );
      internalBatchMaximumTarget.set(batch, maximumTargetCodeUnits);
      fuzzyBatches.push(batch);
      if (observer !== undefined) {
        observer({
          phase: "prepare-fuzzy",
          size: segments.length,
          maximumTargetCodeUnits,
          elapsedMs: elapsedSince(started),
        });
      }
    };

    for (let id = 0; id < items.length; id += 1) {
      const source = items[id];
      if (source === undefined) continue;
      const started = observer === undefined ? 0 : performance.now();
      const record = yield* prepareHistoryRecordCooperatively(
        source,
        id,
        checkpoint,
      );
      records.push(record);
      if (observer !== undefined) {
        observer({
          phase: "prepare-record",
          size: 1,
          elapsedMs: elapsedSince(started),
        });
      }

      if (record.segments.length === 0) {
        recordsWithoutSegments += 1;
        if (recordsWithoutSegments === HISTORY_SEARCH_LIMITS.batchSize) {
          recordsWithoutSegments = 0;
          yield* checkpoint();
        }
      }

      for (const segment of record.segments) {
        pendingSegments.push(segment);
        if (pendingSegments.length === HISTORY_SEARCH_LIMITS.batchSize) {
          flushFuzzyBatch(pendingSegments);
          pendingSegments = [];
          yield* checkpoint();
        }
      }
    }

    if (pendingSegments.length > 0) {
      flushFuzzyBatch(pendingSegments);
      yield* checkpoint();
    }

    const prepared: PreparedHistoryCorpus = { _tag: "PreparedHistoryCorpus" };
    internalCorpora.set(prepared, { records, fuzzyBatches });
    return prepared;
  });

const newestEligibleRecords = (
  corpus: InternalHistoryCorpus,
  scope: HistoryScope,
  currentCwd: string,
  hooks: HistorySearchEngineTestHooks,
): Effect.Effect<EligibleHistoryRecords> =>
  Effect.gen(function* () {
    const newestByRawText = new Map<string, PreparedHistoryRecord>();

    for (
      let start = 0;
      start < corpus.records.length;
      start += HISTORY_SEARCH_LIMITS.batchSize
    ) {
      const batch = corpus.records.slice(
        start,
        start + HISTORY_SEARCH_LIMITS.batchSize,
      );
      for (const record of batch) {
        if (scope === "current-project" && record.item.cwd !== currentCwd) {
          continue;
        }
        const existing = newestByRawText.get(record.item.text);
        if (
          existing === undefined ||
          record.item.timestamp > existing.item.timestamp
        ) {
          newestByRawText.set(record.item.text, record);
        }
      }
      hooks.onEligibilityBatch?.(batch.length);
      yield* Effect.yieldNow();
    }

    const records: Array<PreparedHistoryRecord> = [];
    const recordIds = new Set<number>();
    let outputBatchSize = 0;
    for (const record of newestByRawText.values()) {
      records.push(record);
      recordIds.add(record.id);
      outputBatchSize += 1;
      if (outputBatchSize === HISTORY_SEARCH_LIMITS.batchSize) {
        hooks.onEligibilityBatch?.(outputBatchSize);
        outputBatchSize = 0;
        yield* Effect.yieldNow();
      }
    }
    if (outputBatchSize > 0) {
      hooks.onEligibilityBatch?.(outputBatchSize);
      yield* Effect.yieldNow();
    }

    return { records, recordIds };
  });

const compareTimestampAndRawText = (
  left: PreparedHistoryRecord,
  right: PreparedHistoryRecord,
): number =>
  right.item.timestamp - left.item.timestamp ||
  (left.item.text < right.item.text
    ? -1
    : left.item.text > right.item.text
      ? 1
      : 0);

const emptyQueryOutcome = (
  eligible: EligibleHistoryRecords,
  hooks: HistorySearchEngineTestHooks,
): Effect.Effect<HistorySearchOutcome> =>
  Effect.gen(function* () {
    const retained: Array<PreparedHistoryRecord> = [];
    const capacity = HISTORY_SEARCH_LIMITS.resultLimit + 1;

    for (
      let start = 0;
      start < eligible.records.length;
      start += HISTORY_SEARCH_LIMITS.batchSize
    ) {
      const batch = eligible.records.slice(
        start,
        start + HISTORY_SEARCH_LIMITS.batchSize,
      );
      for (const record of batch) {
        retained.push(record);
        if (retained.length <= capacity) continue;

        let worstIndex = 0;
        for (let index = 1; index < retained.length; index += 1) {
          const currentWorst = retained[worstIndex];
          const candidate = retained[index];
          if (
            currentWorst !== undefined &&
            candidate !== undefined &&
            compareTimestampAndRawText(candidate, currentWorst) > 0
          ) {
            worstIndex = index;
          }
        }
        retained.splice(worstIndex, 1);
      }
      hooks.onEmptyQueryBatch?.(batch.length);
      yield* Effect.yieldNow();
    }

    retained.sort(compareTimestampAndRawText);
    return {
      results: retained
        .slice(0, HISTORY_SEARCH_LIMITS.resultLimit)
        .map((record) => ({ item: record.item })),
      hasMoreResults:
        eligible.records.length > HISTORY_SEARCH_LIMITS.resultLimit,
      fuzzySkippedForLongQuery: false,
    };
  });

const makeBoundedCandidateCollector = (
  capacity: number,
  compare: (
    left: RankedHistoryCandidate,
    right: RankedHistoryCandidate,
  ) => number,
): BoundedCandidateCollector => {
  const retainedByRawText = new Map<string, RankedHistoryCandidate>();
  const matchedRawTexts = new Set<string>();
  const directRawTexts = new Set<string>();

  const retain = (candidate: RankedHistoryCandidate): void => {
    retainedByRawText.set(candidate.item.text, candidate);
    if (retainedByRawText.size <= capacity) return;

    let worst: RankedHistoryCandidate | undefined;
    for (const retained of retainedByRawText.values()) {
      if (worst === undefined || compare(retained, worst) > 0) {
        worst = retained;
      }
    }
    if (worst !== undefined) retainedByRawText.delete(worst.item.text);
  };

  const offerDirect = (candidate: RankedHistoryCandidate): void => {
    const identity = candidate.item.text;
    matchedRawTexts.add(identity);
    directRawTexts.add(identity);
    const existing = retainedByRawText.get(identity);
    if (existing === undefined || existing.matchTier === "fuzzy") {
      retain(candidate);
    }
  };

  const offerFuzzy = (candidate: RankedHistoryCandidate): void => {
    const identity = candidate.item.text;
    matchedRawTexts.add(identity);
    if (directRawTexts.has(identity)) return;

    const existing = retainedByRawText.get(identity);
    if (existing === undefined) {
      retain(candidate);
      return;
    }
    if (
      existing.matchTier === "fuzzy" &&
      compareSameMessageFuzzyEvidence(candidate, existing) < 0
    ) {
      retainedByRawText.set(identity, candidate);
    }
  };

  const discardFuzzy = (): void => {
    for (const [identity, candidate] of retainedByRawText) {
      if (candidate.matchTier === "fuzzy") retainedByRawText.delete(identity);
    }
    matchedRawTexts.clear();
    for (const identity of directRawTexts) matchedRawTexts.add(identity);
  };

  const finish = (
    warning: string | undefined,
    fuzzySkippedForLongQuery: boolean,
  ): HistorySearchOutcome => {
    const results = [...retainedByRawText.values()]
      .sort(compare)
      .slice(0, HISTORY_SEARCH_LIMITS.resultLimit)
      .map((candidate): HistorySearchResult => ({
        item: candidate.item,
        matchTier: candidate.matchTier,
        matchEvidence: candidate.matchEvidence,
      }));
    const outcome = {
      results,
      hasMoreResults: matchedRawTexts.size > HISTORY_SEARCH_LIMITS.resultLimit,
      fuzzySkippedForLongQuery,
    };
    return warning === undefined ? outcome : { ...outcome, warning };
  };

  return { offerDirect, offerFuzzy, discardFuzzy, finish };
};

const runDirectLane = (
  eligible: EligibleHistoryRecords,
  normalizedQuery: string,
  retained: BoundedCandidateCollector,
  observer: HistorySearchBatchObserver | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (
      let start = 0;
      start < eligible.records.length;
      start += HISTORY_SEARCH_LIMITS.batchSize
    ) {
      const batch = eligible.records.slice(
        start,
        start + HISTORY_SEARCH_LIMITS.batchSize,
      );
      const started = observer === undefined ? 0 : performance.now();
      for (const record of batch) {
        const candidate = findDirectMatch(record, normalizedQuery);
        if (candidate !== undefined) retained.offerDirect(candidate);
      }
      if (observer !== undefined) {
        observer({
          phase: "direct",
          size: batch.length,
          elapsedMs: elapsedSince(started),
        });
      }
      yield* Effect.yieldNow();
    }
  });

const runFuzzyLaneDirectlyDegrading = (
  corpus: InternalHistoryCorpus,
  eligible: EligibleHistoryRecords,
  normalizedQuery: string,
  retained: BoundedCandidateCollector,
  observer: HistorySearchBatchObserver | undefined,
  hooks: HistorySearchEngineTestHooks,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    for (
      let batchIndex = 0;
      batchIndex < corpus.fuzzyBatches.length;
      batchIndex += 1
    ) {
      const batch = corpus.fuzzyBatches[batchIndex];
      if (batch === undefined) continue;
      const started = observer === undefined ? 0 : performance.now();
      const attempted = yield* Effect.try({
        try: () => {
          hooks.beforeFuzzyBatch?.(batchIndex);
          return findFuzzyBatchMatches(batch, normalizedQuery);
        },
        catch: () => "Fuzzy history search unavailable",
      }).pipe(Effect.either);
      if (Either.isLeft(attempted)) {
        retained.discardFuzzy();
        yield* Effect.yieldNow();
        return attempted.left;
      }

      const bestByRawText = new Map<string, RankedHistoryCandidate>();
      for (const candidate of attempted.right) {
        if (!eligible.recordIds.has(candidate.recordId)) continue;
        const existing = bestByRawText.get(candidate.item.text);
        if (
          existing === undefined ||
          compareSameMessageFuzzyEvidence(candidate, existing) < 0
        ) {
          bestByRawText.set(candidate.item.text, candidate);
        }
      }
      for (const candidate of bestByRawText.values()) {
        retained.offerFuzzy(candidate);
      }

      if (observer !== undefined) {
        observer({
          phase: "fuzzy",
          size: batch.size,
          maximumTargetCodeUnits: maximumSegmentLength(batch),
          maximumQueryCodeUnits: normalizedQuery.length,
          elapsedMs: elapsedSince(started),
        });
      }
      yield* Effect.yieldNow();
    }
    return undefined;
  });

const makeEngine = (
  observer: HistorySearchBatchObserver | undefined,
  hooks: HistorySearchEngineTestHooks,
): HistorySearchEngineService => ({
  prepare: (items) => prepareCorpus(items, observer),
  search: (prepared, request) =>
    Effect.gen(function* () {
      const corpus = internalCorpora.get(prepared);
      if (corpus === undefined) {
        return yield* Effect.die(
          new Error("Prepared history corpus was not created by this engine"),
        );
      }

      const normalizedQuery = normalizeHistorySearchText(request.query).text;
      const eligible = yield* newestEligibleRecords(
        corpus,
        request.scope,
        request.currentCwd,
        hooks,
      );
      if (normalizedQuery.length === 0) {
        return yield* emptyQueryOutcome(eligible, hooks);
      }

      const retained = makeBoundedCandidateCollector(
        HISTORY_SEARCH_LIMITS.resultLimit + 1,
        compareRankedCandidates,
      );
      yield* runDirectLane(eligible, normalizedQuery, retained, observer);

      let warning: string | undefined;
      if (normalizedQuery.length <= HISTORY_SEARCH_LIMITS.fuzzyQueryCodeUnits) {
        warning = yield* runFuzzyLaneDirectlyDegrading(
          corpus,
          eligible,
          normalizedQuery,
          retained,
          observer,
          hooks,
        );
      }
      return retained.finish(
        warning,
        normalizedQuery.length > HISTORY_SEARCH_LIMITS.fuzzyQueryCodeUnits,
      );
    }),
});

export class HistorySearchEngine extends Context.Tag(
  "pi-extensions/HistorySearchEngine",
)<HistorySearchEngine, HistorySearchEngineService>() {}

export const makeHistorySearchEngineLayer = (
  observer?: HistorySearchBatchObserver,
): Layer.Layer<HistorySearchEngine> =>
  Layer.succeed(HistorySearchEngine, makeEngine(observer, {}));

export const makeHistorySearchEngineTestLayer = (
  hooks: HistorySearchEngineTestHooks,
): Layer.Layer<HistorySearchEngine> =>
  Layer.succeed(HistorySearchEngine, makeEngine(hooks.observer, hooks));

export const HistorySearchEngineLive = makeHistorySearchEngineLayer();
