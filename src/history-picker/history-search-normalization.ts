import { Effect } from "effect";
import type { HistorySourceRange } from "./types";

export const HISTORY_SEARCH_LIMITS = {
  segmentCodeUnits: 512,
  preferredCutLookbackCodeUnits: 64,
  segmentOverlapCodeUnits: 256,
  fuzzyQueryCodeUnits: 256,
  fuzzyEvidenceSpanCodeUnits: 256,
  batchSize: 64,
  resultLimit: 200,
} as const;

const normalizationChunkCodeUnits = 4_096;
const hostYieldIntervalMs = 4;

export type HistorySearchCheckpoint = () => Effect.Effect<void>;

export const makeHistorySearchCheckpoint = (): HistorySearchCheckpoint => {
  let lastHostYieldAt = performance.now();

  return () =>
    Effect.suspend(() => {
      if (performance.now() - lastHostYieldAt < hostYieldIntervalMs) {
        return Effect.yieldNow();
      }
      return Effect.sleep("0 millis").pipe(
        Effect.tap(
          Effect.sync(() => {
            lastHostYieldAt = performance.now();
          }),
        ),
      );
    });
};

export type HistorySearchBreak = "line" | "sentence" | "whitespace";

export interface NormalizedHistoryText {
  readonly text: string;
  readonly sourceByCodeUnit: ReadonlyArray<HistorySourceRange>;
  readonly breakAfter: ReadonlyMap<number, HistorySearchBreak>;
}

export interface HistorySearchSegment {
  readonly text: string;
  readonly normalizedStart: number;
  readonly normalizedEnd: number;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly sourceByCodeUnit: ReadonlyArray<HistorySourceRange>;
}

interface PendingWhitespace {
  start: number;
  end: number;
  kind: HistorySearchBreak;
}

interface NormalizationState {
  readonly rawText: string;
  readonly sourceByCodeUnit: Array<HistorySourceRange>;
  readonly breakAfter: Map<number, HistorySearchBreak>;
  normalizedText: string;
  normalizedChunk: Array<string>;
  normalizedLength: number;
  rawOffset: number;
  skipLfAfterCr: boolean;
  lastNormalizedUnit: string | undefined;
  pendingWhitespace: PendingWhitespace | undefined;
}

const unicodeWhitespace = /\p{White_Space}/u;
const unicodeMark = /\p{Mark}/u;
const unicodeMarks = /\p{Mark}/gu;

const isLineBoundary = (codePoint: string): boolean =>
  codePoint === "\r" ||
  codePoint === "\n" ||
  codePoint === "\u2028" ||
  codePoint === "\u2029";

const isControl = (codePoint: string): boolean => {
  const value = codePoint.codePointAt(0);
  return (
    value !== undefined &&
    ((value >= 0 && value <= 0x1f) || (value >= 0x7f && value <= 0x9f))
  );
};

const isSearchableWhitespace = (codePoint: string): boolean =>
  unicodeWhitespace.test(codePoint) || isControl(codePoint);

const strongerBreak = (
  current: HistorySearchBreak,
  candidate: HistorySearchBreak,
): HistorySearchBreak => {
  if (current === "line" || candidate === "line") return "line";
  if (current === "sentence" || candidate === "sentence") return "sentence";
  return "whitespace";
};

const makeNormalizationState = (rawText: string): NormalizationState => ({
  rawText,
  sourceByCodeUnit: [],
  breakAfter: new Map(),
  normalizedText: "",
  normalizedChunk: [],
  normalizedLength: 0,
  rawOffset: 0,
  skipLfAfterCr: false,
  lastNormalizedUnit: undefined,
  pendingWhitespace: undefined,
});

const appendNormalizedUnit = (
  state: NormalizationState,
  unit: string,
  source: HistorySourceRange,
): void => {
  state.normalizedChunk.push(unit);
  state.sourceByCodeUnit.push(source);
  state.normalizedLength += 1;
  state.lastNormalizedUnit = unit;
};

const flushNormalizedChunk = (state: NormalizationState): void => {
  if (state.normalizedChunk.length === 0) return;
  state.normalizedText += state.normalizedChunk.join("");
  state.normalizedChunk = [];
};

const commitPendingWhitespace = (state: NormalizationState): void => {
  const pending = state.pendingWhitespace;
  state.pendingWhitespace = undefined;
  if (pending === undefined || state.normalizedLength === 0) return;

  appendNormalizedUnit(state, " ", {
    start: pending.start,
    end: pending.end,
  });
  state.breakAfter.set(state.normalizedLength, pending.kind);
};

const extendPreviousSource = (
  state: NormalizationState,
  rawEnd: number,
): void => {
  const sourceIndex = state.sourceByCodeUnit.length - 1;
  const previousSource = state.sourceByCodeUnit[sourceIndex];
  if (previousSource !== undefined) {
    state.sourceByCodeUnit[sourceIndex] = {
      start: previousSource.start,
      end: rawEnd,
    };
  }
};

const processCodePoint = (
  state: NormalizationState,
  codePoint: string,
): void => {
  const rawStart = state.rawOffset;
  state.rawOffset += codePoint.length;

  if (state.skipLfAfterCr && codePoint === "\n") {
    state.skipLfAfterCr = false;
    return;
  }
  state.skipLfAfterCr = false;

  const isCrLf = codePoint === "\r" && state.rawText[state.rawOffset] === "\n";
  const rawEnd = state.rawOffset + (isCrLf ? 1 : 0);
  if (isCrLf) state.skipLfAfterCr = true;

  if (isSearchableWhitespace(codePoint)) {
    const candidateBreak: HistorySearchBreak = isLineBoundary(codePoint)
      ? "line"
      : "whitespace";
    const pending = state.pendingWhitespace;

    if (pending !== undefined) {
      pending.end = rawEnd;
      pending.kind = strongerBreak(pending.kind, candidateBreak);
      return;
    }

    const previousUnit = state.lastNormalizedUnit;
    const kind =
      candidateBreak === "line"
        ? "line"
        : previousUnit === "." || previousUnit === "!" || previousUnit === "?"
          ? "sentence"
          : "whitespace";
    state.pendingWhitespace = { start: rawStart, end: rawEnd, kind };
    return;
  }

  const normalizedFragment = codePoint
    .toLowerCase()
    .normalize("NFD")
    .replace(unicodeMarks, "")
    .replaceAll("ł", "l");

  if (normalizedFragment.length === 0 && unicodeMark.test(codePoint)) {
    const pending = state.pendingWhitespace;
    if (pending === undefined) {
      extendPreviousSource(state, rawEnd);
    } else {
      pending.end = rawEnd;
    }
    return;
  }

  commitPendingWhitespace(state);
  for (let index = 0; index < normalizedFragment.length; index += 1) {
    appendNormalizedUnit(state, normalizedFragment[index] ?? "", {
      start: rawStart,
      end: rawEnd,
    });
  }
};

const normalizeHistorySearchTextSteps = function* (
  rawText: string,
): Generator<void, NormalizedHistoryText> {
  const state = makeNormalizationState(rawText);
  let chunkCodeUnits = 0;
  let yieldedDuringTraversal = false;

  for (const codePoint of rawText) {
    processCodePoint(state, codePoint);
    chunkCodeUnits += codePoint.length;
    if (chunkCodeUnits >= normalizationChunkCodeUnits) {
      chunkCodeUnits = 0;
      yieldedDuringTraversal = true;
      flushNormalizedChunk(state);
      yield;
    }
  }

  state.pendingWhitespace = undefined;
  flushNormalizedChunk(state);
  if (yieldedDuringTraversal) yield;

  return {
    text: state.normalizedText,
    sourceByCodeUnit: state.sourceByCodeUnit,
    breakAfter: state.breakAfter,
  };
};

export const normalizeHistorySearchText = (
  rawText: string,
): NormalizedHistoryText => {
  const steps = normalizeHistorySearchTextSteps(rawText);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

export const normalizeHistorySearchTextCooperatively = (
  rawText: string,
  checkpoint?: HistorySearchCheckpoint,
): Effect.Effect<NormalizedHistoryText> =>
  Effect.suspend(() => {
    const activeCheckpoint = checkpoint ?? makeHistorySearchCheckpoint();
    const steps = normalizeHistorySearchTextSteps(rawText);

    return Effect.gen(function* () {
      let step = steps.next();
      while (!step.done) {
        yield* activeCheckpoint();
        step = steps.next();
      }
      return step.value;
    });
  });

const preferredCut = (
  normalized: NormalizedHistoryText,
  segmentEnd: number,
): number | undefined => {
  const windowStart =
    segmentEnd - HISTORY_SEARCH_LIMITS.preferredCutLookbackCodeUnits;
  let lastLine: number | undefined;
  let lastSentence: number | undefined;
  let lastWhitespace: number | undefined;

  for (let position = segmentEnd; position > windowStart; position -= 1) {
    const kind = normalized.breakAfter.get(position);
    if (kind === "line" && lastLine === undefined) lastLine = position;
    else if (kind === "sentence" && lastSentence === undefined) {
      lastSentence = position;
    } else if (kind === "whitespace" && lastWhitespace === undefined) {
      lastWhitespace = position;
    }
  }

  return lastLine ?? lastSentence ?? lastWhitespace;
};

const segmentHistorySearchTextSteps = function* (
  normalized: NormalizedHistoryText,
): Generator<void, ReadonlyArray<HistorySearchSegment>> {
  if (normalized.text.length === 0) return [];

  const segments: Array<HistorySearchSegment> = [];
  let normalizedStart = 0;
  let batchSize = 0;

  while (normalizedStart < normalized.text.length) {
    const cappedEnd = Math.min(
      normalizedStart + HISTORY_SEARCH_LIMITS.segmentCodeUnits,
      normalized.text.length,
    );
    const isFinalSegment = cappedEnd === normalized.text.length;
    const naturalCut = isFinalSegment
      ? undefined
      : preferredCut(normalized, cappedEnd);
    const normalizedEnd = naturalCut ?? cappedEnd;
    const segmentSources = normalized.sourceByCodeUnit.slice(
      normalizedStart,
      normalizedEnd,
    );
    const firstSource = segmentSources[0];
    const lastSource = segmentSources.at(-1);

    if (firstSource === undefined || lastSource === undefined) break;

    segments.push({
      text: normalized.text.slice(normalizedStart, normalizedEnd),
      normalizedStart,
      normalizedEnd,
      rawStart: firstSource.start,
      rawEnd: lastSource.end,
      sourceByCodeUnit: segmentSources,
    });
    batchSize += 1;

    if (isFinalSegment) break;

    normalizedStart =
      normalizedEnd - HISTORY_SEARCH_LIMITS.segmentOverlapCodeUnits;

    if (batchSize === HISTORY_SEARCH_LIMITS.batchSize) {
      batchSize = 0;
      yield;
    }
  }

  return segments;
};

export const segmentHistorySearchText = (
  normalized: NormalizedHistoryText,
): ReadonlyArray<HistorySearchSegment> => {
  const steps = segmentHistorySearchTextSteps(normalized);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

export const segmentHistorySearchTextCooperatively = (
  normalized: NormalizedHistoryText,
  checkpoint?: HistorySearchCheckpoint,
): Effect.Effect<ReadonlyArray<HistorySearchSegment>> =>
  Effect.suspend(() => {
    const activeCheckpoint = checkpoint ?? makeHistorySearchCheckpoint();
    const steps = segmentHistorySearchTextSteps(normalized);

    return Effect.gen(function* () {
      let step = steps.next();
      while (!step.done) {
        yield* activeCheckpoint();
        step = steps.next();
      }
      return step.value;
    });
  });
