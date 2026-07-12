import createFuzzySearch from "@nozbe/microfuzz";
import { Effect, Schema } from "effect";
import {
  HISTORY_SEARCH_LIMITS,
  makeHistorySearchCheckpoint,
  normalizeHistorySearchText,
  normalizeHistorySearchTextCooperatively,
  segmentHistorySearchText,
  segmentHistorySearchTextCooperatively,
  type HistorySearchCheckpoint,
  type HistorySearchSegment,
  type NormalizedHistoryText,
} from "./history-search-normalization";
import type {
  HistoryItem,
  HistoryMatchEvidence,
  HistoryMatchTier,
  HistorySourceRange,
} from "./types";

export interface PreparedHistorySegment extends HistorySearchSegment {
  readonly recordId: number;
}

export interface PreparedHistoryRecord {
  readonly id: number;
  readonly item: HistoryItem;
  readonly normalizedText: string;
  readonly sourceByCodeUnit: ReadonlyArray<HistorySourceRange>;
  readonly segments: ReadonlyArray<PreparedHistorySegment>;
}

export interface RankedHistoryCandidate {
  readonly recordId: number;
  readonly item: HistoryItem;
  readonly matchTier: HistoryMatchTier;
  readonly fuzzyQuality?: number;
  readonly matchEvidence: HistoryMatchEvidence;
}

export interface PreparedFuzzyBatch {
  readonly size: number;
  readonly search: (query: string) => ReadonlyArray<unknown>;
}

interface AdapterFuzzySearchOptions {
  readonly getText: (segment: PreparedHistorySegment) => Array<string>;
  readonly strategy: "smart";
}

type AdapterFuzzySearchFactory = (
  segments: Array<PreparedHistorySegment>,
  options: AdapterFuzzySearchOptions,
) => (query: string) => ReadonlyArray<unknown>;

interface PreparedSegmentMetadata {
  readonly segment: PreparedHistorySegment;
  readonly item: HistoryItem;
}

const finiteNumberSchema = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value)),
);
const inclusiveRangeSchema = Schema.Tuple(Schema.Int, Schema.Int);
const inclusiveRangeListSchema = Schema.Array(inclusiveRangeSchema);
const fuzzyResultSchema = Schema.Struct({
  item: Schema.Unknown,
  score: finiteNumberSchema,
  matches: Schema.Array(Schema.Union(inclusiveRangeListSchema, Schema.Null)),
});
const isFuzzyResult = Schema.is(fuzzyResultSchema);

const preparedSegmentItems = new WeakMap<PreparedHistorySegment, HistoryItem>();
const fuzzyBatchMetadata = new WeakMap<
  PreparedFuzzyBatch,
  ReadonlyMap<object, PreparedSegmentMetadata>
>();

const liveCreate: AdapterFuzzySearchFactory = (segments, options) => {
  const search = createFuzzySearch(segments, {
    getText: options.getText,
    strategy: options.strategy,
  });
  return (query) => search(query);
};

const copyHistoryItem = (item: HistoryItem): HistoryItem => ({
  text: item.text,
  timestamp: item.timestamp,
  sessionFile: item.sessionFile,
  cwd: item.cwd,
  source: item.source,
});

const makePreparedHistoryRecord = (
  canonicalItem: HistoryItem,
  id: number,
  normalized: NormalizedHistoryText,
  segments: ReadonlyArray<PreparedHistorySegment>,
): PreparedHistoryRecord => ({
  id,
  item: canonicalItem,
  normalizedText: normalized.text,
  sourceByCodeUnit: normalized.sourceByCodeUnit,
  segments,
});

const registerPreparedSegment = (
  segment: HistorySearchSegment,
  canonicalItem: HistoryItem,
  recordId: number,
): PreparedHistorySegment => {
  const prepared = { ...segment, recordId };
  preparedSegmentItems.set(prepared, canonicalItem);
  return prepared;
};

export const prepareHistoryRecord = (
  item: HistoryItem,
  id: number,
): PreparedHistoryRecord => {
  const canonicalItem = copyHistoryItem(item);
  const normalized = normalizeHistorySearchText(canonicalItem.text);
  const segments = segmentHistorySearchText(normalized).map((segment) =>
    registerPreparedSegment(segment, canonicalItem, id),
  );

  return makePreparedHistoryRecord(canonicalItem, id, normalized, segments);
};

export const prepareHistoryRecordCooperatively = (
  item: HistoryItem,
  id: number,
  checkpoint?: HistorySearchCheckpoint,
): Effect.Effect<PreparedHistoryRecord> =>
  Effect.suspend(() => {
    const activeCheckpoint = checkpoint ?? makeHistorySearchCheckpoint();
    const canonicalItem = copyHistoryItem(item);

    return Effect.gen(function* () {
      const normalized = yield* normalizeHistorySearchTextCooperatively(
        canonicalItem.text,
        activeCheckpoint,
      );
      const sourceSegments = yield* segmentHistorySearchTextCooperatively(
        normalized,
        activeCheckpoint,
      );
      const segments: Array<PreparedHistorySegment> = [];
      let batchSize = 0;

      for (const segment of sourceSegments) {
        segments.push(registerPreparedSegment(segment, canonicalItem, id));
        batchSize += 1;
        if (batchSize === HISTORY_SEARCH_LIMITS.batchSize) {
          batchSize = 0;
          yield* activeCheckpoint();
        }
      }

      return makePreparedHistoryRecord(canonicalItem, id, normalized, segments);
    });
  });

export const prepareFuzzyBatch = (
  segments: ReadonlyArray<PreparedHistorySegment>,
  create: AdapterFuzzySearchFactory = liveCreate,
): PreparedFuzzyBatch => {
  if (segments.length > HISTORY_SEARCH_LIMITS.batchSize) {
    throw new RangeError(
      `History search fuzzy batches cannot exceed ${HISTORY_SEARCH_LIMITS.batchSize} segments`,
    );
  }

  const copiedSegments = [...segments];
  const segmentMetadata = new Map<object, PreparedSegmentMetadata>();
  for (const segment of copiedSegments) {
    const item = preparedSegmentItems.get(segment);
    if (item !== undefined) {
      segmentMetadata.set(segment, { segment, item });
    }
  }

  const search = create(copiedSegments, {
    getText: (segment) => [segment.text],
    strategy: "smart",
  });
  const prepared: PreparedFuzzyBatch = {
    size: copiedSegments.length,
    search: (query) => search(query),
  };
  fuzzyBatchMetadata.set(prepared, segmentMetadata);
  return prepared;
};

const directEvidence = (
  record: PreparedHistoryRecord,
  start: number,
  length: number,
): HistoryMatchEvidence | undefined => {
  const first = record.sourceByCodeUnit[start];
  const last = record.sourceByCodeUnit[start + length - 1];
  if (first === undefined || last === undefined) return undefined;

  const range = { start: first.start, end: last.end };
  return { sourceRanges: [range], focusRange: range };
};

const precedingCodePoint = (
  text: string,
  codeUnitIndex: number,
): string | undefined => {
  if (codeUnitIndex <= 0) return undefined;

  let start = codeUnitIndex - 1;
  const trailingUnit = text.charCodeAt(start);
  if (trailingUnit >= 0xdc00 && trailingUnit <= 0xdfff && start > 0) {
    const leadingUnit = text.charCodeAt(start - 1);
    if (leadingUnit >= 0xd800 && leadingUnit <= 0xdbff) start -= 1;
  }

  const value = text.codePointAt(start);
  return value === undefined ? undefined : String.fromCodePoint(value);
};

const directBoundary = /[\s\p{P}]/u;

export const findDirectMatch = (
  record: PreparedHistoryRecord,
  normalizedQuery: string,
): RankedHistoryCandidate | undefined => {
  if (normalizedQuery.length === 0) return undefined;

  let start = record.normalizedText.indexOf(normalizedQuery);
  if (start < 0) return undefined;

  let matchTier: HistoryMatchTier = "substring";
  if (record.normalizedText === normalizedQuery) {
    matchTier = "exact";
  } else {
    let occurrence = start;
    while (occurrence >= 0) {
      const previousCodePoint = precedingCodePoint(
        record.normalizedText,
        occurrence,
      );
      if (
        occurrence === 0 ||
        (previousCodePoint !== undefined &&
          directBoundary.test(previousCodePoint))
      ) {
        start = occurrence;
        matchTier = "word-boundary";
        break;
      }
      occurrence = record.normalizedText.indexOf(
        normalizedQuery,
        occurrence + 1,
      );
    }
  }

  const matchEvidence = directEvidence(record, start, normalizedQuery.length);
  if (matchEvidence === undefined) return undefined;

  return {
    recordId: record.id,
    item: record.item,
    matchTier,
    matchEvidence,
  };
};

const evidenceFromRawRanges = (
  ranges: ReadonlyArray<HistorySourceRange>,
): HistoryMatchEvidence | undefined => {
  const ordered = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const coalesced: Array<HistorySourceRange> = [];
  for (const range of ordered) {
    const previous = coalesced.at(-1);
    if (previous !== undefined && range.start < previous.end) {
      coalesced[coalesced.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else {
      coalesced.push(range);
    }
  }

  const first = coalesced[0];
  const last = coalesced.at(-1);
  if (first === undefined || last === undefined) return undefined;

  return {
    sourceRanges: coalesced,
    focusRange: { start: first.start, end: last.end },
  };
};

interface MappedFuzzyRanges {
  readonly matchEvidence: HistoryMatchEvidence;
  readonly normalizedStart: number;
  readonly normalizedEnd: number;
}

const mapInclusiveRanges = (
  segment: PreparedHistorySegment,
  ranges: ReadonlyArray<readonly [number, number]>,
): MappedFuzzyRanges | undefined => {
  const rawRanges: Array<HistorySourceRange> = [];
  let normalizedStart = segment.normalizedEnd;
  let normalizedEnd = segment.normalizedStart;

  for (const [inclusiveStart, inclusiveEnd] of ranges) {
    if (
      inclusiveStart < 0 ||
      inclusiveStart > inclusiveEnd ||
      inclusiveEnd >= segment.text.length
    ) {
      return undefined;
    }

    const globalStart = segment.normalizedStart + inclusiveStart;
    const globalEnd = segment.normalizedStart + inclusiveEnd + 1;
    if (
      globalStart < segment.normalizedStart ||
      globalEnd > segment.normalizedEnd
    ) {
      return undefined;
    }

    normalizedStart = Math.min(normalizedStart, globalStart);
    normalizedEnd = Math.max(normalizedEnd, globalEnd);

    const first = segment.sourceByCodeUnit[inclusiveStart];
    const last = segment.sourceByCodeUnit[inclusiveEnd];
    if (first === undefined || last === undefined) return undefined;
    rawRanges.push({ start: first.start, end: last.end });
  }

  const matchEvidence = evidenceFromRawRanges(rawRanges);
  if (matchEvidence === undefined || normalizedStart >= normalizedEnd) {
    return undefined;
  }
  return { matchEvidence, normalizedStart, normalizedEnd };
};

interface CombinedFuzzyMatch {
  readonly preparedSegment: PreparedSegmentMetadata;
  readonly fuzzyQuality: number;
  readonly sourceRanges: ReadonlyArray<HistorySourceRange>;
  readonly normalizedStart: number;
  readonly normalizedEnd: number;
}

const validatedTokenMatches = (
  prepared: PreparedFuzzyBatch,
  metadata: ReadonlyMap<object, PreparedSegmentMetadata>,
  token: string,
): ReadonlyMap<object, CombinedFuzzyMatch> => {
  const matches = new Map<object, CombinedFuzzyMatch>();

  for (const result of prepared.search(token)) {
    if (!isFuzzyResult(result)) continue;
    if (typeof result.item !== "object" || result.item === null) continue;

    const preparedSegment = metadata.get(result.item);
    const ranges = result.matches[0];
    if (
      preparedSegment === undefined ||
      ranges === undefined ||
      ranges === null ||
      ranges.length === 0
    ) {
      continue;
    }

    const mapped = mapInclusiveRanges(preparedSegment.segment, ranges);
    if (
      mapped === undefined ||
      mapped.normalizedEnd - mapped.normalizedStart >
        HISTORY_SEARCH_LIMITS.fuzzyEvidenceSpanCodeUnits
    ) {
      continue;
    }

    const existing = matches.get(result.item);
    if (existing === undefined || result.score < existing.fuzzyQuality) {
      matches.set(result.item, {
        preparedSegment,
        fuzzyQuality: result.score,
        sourceRanges: mapped.matchEvidence.sourceRanges,
        normalizedStart: mapped.normalizedStart,
        normalizedEnd: mapped.normalizedEnd,
      });
    }
  }

  return matches;
};

export const findFuzzyBatchMatches = (
  prepared: PreparedFuzzyBatch,
  query: string,
): ReadonlyArray<RankedHistoryCandidate> => {
  if (
    query.length === 0 ||
    query.length > HISTORY_SEARCH_LIMITS.fuzzyQueryCodeUnits
  ) {
    return [];
  }

  const metadata = fuzzyBatchMetadata.get(prepared);
  if (metadata === undefined) return [];

  const tokens = query.split(/\s+/u).filter((token) => token.length > 0);
  let combined: ReadonlyMap<object, CombinedFuzzyMatch> | undefined;

  for (const token of tokens) {
    const tokenMatches = validatedTokenMatches(prepared, metadata, token);
    if (combined === undefined) {
      combined = tokenMatches;
      continue;
    }

    const intersection = new Map<object, CombinedFuzzyMatch>();
    for (const [segment, prior] of combined) {
      const current = tokenMatches.get(segment);
      if (current === undefined) continue;

      const fuzzyQuality = prior.fuzzyQuality + current.fuzzyQuality;
      if (!Number.isFinite(fuzzyQuality)) continue;

      const normalizedStart = Math.min(
        prior.normalizedStart,
        current.normalizedStart,
      );
      const normalizedEnd = Math.max(
        prior.normalizedEnd,
        current.normalizedEnd,
      );
      if (
        normalizedEnd - normalizedStart >
        HISTORY_SEARCH_LIMITS.fuzzyEvidenceSpanCodeUnits
      ) {
        continue;
      }

      intersection.set(segment, {
        preparedSegment: prior.preparedSegment,
        fuzzyQuality,
        sourceRanges: [...prior.sourceRanges, ...current.sourceRanges],
        normalizedStart,
        normalizedEnd,
      });
    }
    combined = intersection;
  }

  if (combined === undefined) return [];

  const candidates: Array<RankedHistoryCandidate> = [];
  for (const match of combined.values()) {
    const matchEvidence = evidenceFromRawRanges(match.sourceRanges);
    if (matchEvidence === undefined) continue;

    candidates.push({
      recordId: match.preparedSegment.segment.recordId,
      item: match.preparedSegment.item,
      matchTier: "fuzzy",
      fuzzyQuality: match.fuzzyQuality,
      matchEvidence,
    });
  }
  return candidates;
};

const tierOrdinal: Readonly<Record<HistoryMatchTier, number>> = {
  exact: 0,
  "word-boundary": 1,
  substring: 2,
  fuzzy: 3,
};

const compareNumbers = (left: number, right: number): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareOptionalQuality = (
  left: number | undefined,
  right: number | undefined,
): number => {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return compareNumbers(left, right);
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareRankedCandidates = (
  left: RankedHistoryCandidate,
  right: RankedHistoryCandidate,
): number => {
  const tierComparison =
    tierOrdinal[left.matchTier] - tierOrdinal[right.matchTier];
  if (tierComparison !== 0) return tierComparison;

  if (left.matchTier === "fuzzy" && right.matchTier === "fuzzy") {
    const qualityComparison = compareOptionalQuality(
      left.fuzzyQuality,
      right.fuzzyQuality,
    );
    if (qualityComparison !== 0) return qualityComparison;
  }

  return (
    compareNumbers(right.item.timestamp, left.item.timestamp) ||
    compareText(left.item.text, right.item.text)
  );
};

export const compareSameMessageFuzzyEvidence = (
  left: RankedHistoryCandidate,
  right: RankedHistoryCandidate,
): number =>
  compareOptionalQuality(left.fuzzyQuality, right.fuzzyQuality) ||
  compareNumbers(
    left.matchEvidence.focusRange.end - left.matchEvidence.focusRange.start,
    right.matchEvidence.focusRange.end - right.matchEvidence.focusRange.start,
  ) ||
  compareNumbers(
    left.matchEvidence.focusRange.start,
    right.matchEvidence.focusRange.start,
  );
