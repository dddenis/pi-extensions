import { visibleWidth } from "@earendil-works/pi-tui";
import type { HistoryMatchEvidence, HistorySourceRange } from "./types";

const OMISSION = "…";
const LINE_BOUNDARY = "↵";
const CONTROL_REPLACEMENT = "�";
const MINIMUM_SOURCE_CODE_UNITS = 256;
const SOURCE_CODE_UNITS_PER_CELL = 32;
const INITIAL_SOURCE_CODE_UNITS_PER_CELL = 4;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

interface PreviewToken extends HistorySourceRange {
  readonly text: string;
  readonly width: number;
  readonly kind: "content" | "line" | "space" | "control";
}

interface NormalizedSourceWindow {
  readonly tokens: ReadonlyArray<PreviewToken>;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

interface TokenProjection {
  readonly text: string;
  readonly width: number;
  readonly omittedBefore: boolean;
  readonly omittedAfter: boolean;
  readonly allAvailableContextFits: boolean;
}

const lineBoundary = /^(?:\r\n|\r|\n|\u2028|\u2029)$/u;
const ordinaryWhitespace = /^[\p{White_Space}\t]+$/v;
const terminalControl = /^[\p{Control}\p{Surrogate}]+$/v;

const normalizedKind = (
  segment: string,
): Pick<PreviewToken, "text" | "kind"> | undefined => {
  if (lineBoundary.test(segment)) return { text: LINE_BOUNDARY, kind: "line" };
  if (ordinaryWhitespace.test(segment)) return { text: " ", kind: "space" };
  if (terminalControl.test(segment)) {
    return { text: CONTROL_REPLACEMENT, kind: "control" };
  }
  if (visibleWidth(segment) === 0) return undefined;
  return { text: segment, kind: "content" };
};

const normalizeSourceWindow = (
  rawText: string,
  sourceStart: number,
  sourceEnd: number,
): NormalizedSourceWindow => {
  const sourceSlice = rawText.slice(sourceStart, sourceEnd);
  const segments = [...graphemeSegmenter.segment(sourceSlice)];
  const retainedStart = sourceStart > 0 ? 1 : 0;
  const retainedEnd =
    sourceEnd < rawText.length ? segments.length - 1 : segments.length;
  const tokens: PreviewToken[] = [];

  for (const segment of segments.slice(retainedStart, retainedEnd)) {
    const normalized = normalizedKind(segment.segment);
    if (normalized === undefined) continue;

    const start = sourceStart + segment.index;
    const token: PreviewToken = {
      ...normalized,
      start,
      end: start + segment.segment.length,
      width: visibleWidth(normalized.text),
    };
    const previous = tokens.at(-1);
    if (
      previous !== undefined &&
      previous.kind === token.kind &&
      token.kind !== "content"
    ) {
      tokens[tokens.length - 1] = { ...previous, end: token.end };
    } else {
      tokens.push(token);
    }
  }

  return { tokens, sourceStart, sourceEnd };
};

const normalizedCellBudget = (availableCells: number): number =>
  Number.isFinite(availableCells) ? Math.max(0, Math.floor(availableCells)) : 0;

const validFocusRange = (
  rawText: string,
  matchEvidence: HistoryMatchEvidence | undefined,
): HistorySourceRange | undefined => {
  const range = matchEvidence?.focusRange;
  if (
    range === undefined ||
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    range.start < 0 ||
    range.end <= range.start ||
    range.start >= rawText.length
  ) {
    return undefined;
  }
  const start = Math.floor(range.start);
  const end = Math.min(rawText.length, Math.ceil(range.end));
  return end > start ? { start, end } : undefined;
};

const sourceWindowBounds = (
  rawLength: number,
  focus: HistorySourceRange | undefined,
  sourceBudget: number,
): HistorySourceRange => {
  const budget = Math.min(rawLength, sourceBudget);
  if (focus === undefined) return { start: 0, end: budget };

  const focusLength = focus.end - focus.start;
  if (focusLength >= budget) {
    const start = focus.start > 0 ? focus.start - 1 : 0;
    return { start, end: Math.min(rawLength, start + budget) };
  }

  const remaining = budget - focusLength;
  const leading = Math.floor(remaining / 2);
  const trailing = remaining - leading;
  let start = Math.max(0, focus.start - leading);
  let end = Math.min(rawLength, focus.end + trailing);

  const unused = budget - (end - start);
  if (unused > 0 && start === 0) end = Math.min(rawLength, end + unused);
  if (end - start < budget && end === rawLength) {
    start = Math.max(0, end - budget);
  }
  return { start, end };
};

const tokenWidth = (
  tokens: ReadonlyArray<PreviewToken>,
  start: number,
  end: number,
): number => {
  let width = 0;
  for (let index = start; index < end; index += 1) {
    width += tokens[index]?.width ?? 0;
  }
  return width;
};

const safeTokenProjection = (
  tokens: ReadonlyArray<PreviewToken>,
  start: number,
  end: number,
  omittedBefore: boolean,
  omittedAfter: boolean,
  availableCells: number,
  allAvailableContextFits: boolean,
): TokenProjection => {
  const content = tokens
    .slice(start, end)
    .map((token) => token.text)
    .join("");
  const text = `${omittedBefore ? OMISSION : ""}${content}${omittedAfter ? OMISSION : ""}`;
  const width = visibleWidth(text);
  if (width <= availableCells) {
    return {
      text,
      width,
      omittedBefore,
      omittedAfter,
      allAvailableContextFits,
    };
  }
  return {
    text: availableCells > 0 ? OMISSION : "",
    width: availableCells > 0 ? 1 : 0,
    omittedBefore: true,
    omittedAfter: true,
    allAvailableContextFits: false,
  };
};

const projectBeginning = (
  window: NormalizedSourceWindow,
  rawLength: number,
  availableCells: number,
): TokenProjection => {
  const { tokens } = window;
  const allSourceAvailable =
    window.sourceStart === 0 && window.sourceEnd === rawLength;
  const totalWidth = tokenWidth(tokens, 0, tokens.length);
  if (allSourceAvailable && totalWidth <= availableCells) {
    return safeTokenProjection(
      tokens,
      0,
      tokens.length,
      false,
      false,
      availableCells,
      true,
    );
  }

  const contentBudget = Math.max(0, availableCells - 1);
  let end = 0;
  let width = 0;
  while (end < tokens.length) {
    const nextWidth = tokens[end]?.width ?? 0;
    if (width + nextWidth > contentBudget) break;
    width += nextWidth;
    end += 1;
  }
  if (end === 0) {
    return {
      text: OMISSION,
      width: 1,
      omittedBefore: false,
      omittedAfter: true,
      allAvailableContextFits: false,
    };
  }
  const omittedAfter =
    end < tokens.length ||
    window.sourceEnd < rawLength ||
    (tokens[end - 1]?.end ?? 0) < rawLength;
  return safeTokenProjection(
    tokens,
    0,
    end,
    false,
    omittedAfter,
    availableCells,
    end === tokens.length,
  );
};

const projectFocused = (
  window: NormalizedSourceWindow,
  focus: HistorySourceRange,
  rawLength: number,
  availableCells: number,
): TokenProjection => {
  const { tokens } = window;
  const focusedIndexes = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.end > focus.start && token.start < focus.end)
    .map(({ index }) => index);
  const firstFocused = focusedIndexes.at(0);
  const lastFocused = focusedIndexes.at(-1);
  if (firstFocused === undefined || lastFocused === undefined) {
    return {
      text: OMISSION,
      width: 1,
      omittedBefore: true,
      omittedAfter: true,
      allAvailableContextFits: false,
    };
  }

  const focusEnd = lastFocused + 1;
  const focusWidth = tokenWidth(tokens, firstFocused, focusEnd);
  let omittedBefore = (tokens[firstFocused]?.start ?? 0) > 0;
  let omittedAfter = (tokens[lastFocused]?.end ?? rawLength) < rawLength;
  const markerWidth = Number(omittedBefore) + Number(omittedAfter);

  if (focusWidth + markerWidth > availableCells) {
    let end = firstFocused;
    let width = 0;
    const firstFocusedWidth = tokens[firstFocused]?.width ?? availableCells;
    const leadingMarker =
      omittedBefore && firstFocusedWidth + 2 <= availableCells;
    const contentBudget = Math.max(
      0,
      availableCells - Number(leadingMarker) - 1,
    );
    while (end < focusEnd) {
      const nextWidth = tokens[end]?.width ?? 0;
      if (width + nextWidth > contentBudget) break;
      width += nextWidth;
      end += 1;
    }
    if (end === firstFocused) {
      return {
        text: OMISSION,
        width: 1,
        omittedBefore,
        omittedAfter: true,
        allAvailableContextFits: false,
      };
    }
    return safeTokenProjection(
      tokens,
      firstFocused,
      end,
      leadingMarker,
      true,
      availableCells,
      false,
    );
  }

  let start = firstFocused;
  let end = focusEnd;
  let includedWidth = focusWidth;
  const remaining = availableCells - includedWidth - markerWidth;
  const leadingBudget = Math.floor(remaining / 2);
  const trailingBudget = remaining - leadingBudget;

  let leadingSpent = 0;
  while (start > 0) {
    const nextWidth = tokens[start - 1]?.width ?? 0;
    if (leadingSpent + nextWidth > leadingBudget) break;
    leadingSpent += nextWidth;
    includedWidth += nextWidth;
    start -= 1;
  }

  let trailingSpent = 0;
  while (end < tokens.length) {
    const nextWidth = tokens[end]?.width ?? 0;
    if (trailingSpent + nextWidth > trailingBudget) break;
    trailingSpent += nextWidth;
    includedWidth += nextWidth;
    end += 1;
  }

  const recomputeOmissions = (): void => {
    omittedBefore = (tokens[start]?.start ?? 0) > 0;
    omittedAfter = (tokens[end - 1]?.end ?? rawLength) < rawLength;
  };
  recomputeOmissions();

  if (!omittedBefore && omittedAfter) {
    while (end < tokens.length) {
      const used = includedWidth + Number(omittedAfter);
      const free = availableCells - used;
      const nextWidth = tokens[end]?.width ?? 0;
      if (nextWidth > free) break;
      includedWidth += nextWidth;
      end += 1;
      recomputeOmissions();
    }
  } else if (omittedBefore && !omittedAfter) {
    while (start > 0) {
      const used = includedWidth + Number(omittedBefore);
      const free = availableCells - used;
      const nextWidth = tokens[start - 1]?.width ?? 0;
      if (nextWidth > free) break;
      includedWidth += nextWidth;
      start -= 1;
      recomputeOmissions();
    }
  }

  return safeTokenProjection(
    tokens,
    start,
    end,
    omittedBefore,
    omittedAfter,
    availableCells,
    start === 0 && end === tokens.length,
  );
};

const projectTokenWindow = (
  window: NormalizedSourceWindow,
  focus: HistorySourceRange | undefined,
  rawLength: number,
  availableCells: number,
): TokenProjection => {
  const totalWidth = tokenWidth(window.tokens, 0, window.tokens.length);
  if (
    window.sourceStart === 0 &&
    window.sourceEnd === rawLength &&
    totalWidth <= availableCells
  ) {
    return safeTokenProjection(
      window.tokens,
      0,
      window.tokens.length,
      false,
      false,
      availableCells,
      true,
    );
  }
  if (focus === undefined) {
    return projectBeginning(window, rawLength, availableCells);
  }
  return projectFocused(window, focus, rawLength, availableCells);
};

export const projectHistoryPreview = (
  rawText: string,
  matchEvidence: HistoryMatchEvidence | undefined,
  availableCells: number,
): string => {
  const width = normalizedCellBudget(availableCells);
  if (width === 0 || rawText.length === 0) return "";

  const focus = validFocusRange(rawText, matchEvidence);
  const maximumSourceBudget = Math.min(
    rawText.length,
    Math.max(MINIMUM_SOURCE_CODE_UNITS, width * SOURCE_CODE_UNITS_PER_CELL),
  );
  let sourceBudget = Math.min(
    maximumSourceBudget,
    Math.max(64, width * INITIAL_SOURCE_CODE_UNITS_PER_CELL),
  );
  let best: TokenProjection = {
    text: OMISSION,
    width: 1,
    omittedBefore: true,
    omittedAfter: true,
    allAvailableContextFits: false,
  };

  while (sourceBudget > 0) {
    const bounds = sourceWindowBounds(rawText.length, focus, sourceBudget);
    const normalized = normalizeSourceWindow(rawText, bounds.start, bounds.end);
    const projection = projectTokenWindow(
      normalized,
      focus,
      rawText.length,
      width,
    );
    if (projection.text !== OMISSION || best.text === OMISSION)
      best = projection;

    const focusSurvived =
      focus === undefined ||
      normalized.tokens.some(
        (token) => token.end > focus.start && token.start < focus.end,
      );
    const bothSourceEdgesExhausted =
      bounds.start === 0 && bounds.end === rawText.length;
    if (
      (focusSurvived && projection.width >= width) ||
      bothSourceEdgesExhausted ||
      (focusSurvived && projection.allAvailableContextFits) ||
      sourceBudget >= maximumSourceBudget
    ) {
      break;
    }
    sourceBudget = Math.min(maximumSourceBudget, sourceBudget * 2);
  }

  return best.text;
};
