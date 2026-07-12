import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  compareRankedCandidates,
  compareSameMessageFuzzyEvidence,
  findDirectMatch,
  findFuzzyBatchMatches,
  prepareFuzzyBatch,
  prepareHistoryRecord,
  prepareHistoryRecordCooperatively,
  type RankedHistoryCandidate,
} from "./history-search-adapter";
import {
  HISTORY_SEARCH_LIMITS,
  normalizeHistorySearchText,
} from "./history-search-normalization";
import type { HistoryItem } from "./types";

const item = (text: string, timestamp = 1): HistoryItem => ({
  text,
  timestamp,
  cwd: "/project",
  sessionFile: `/sessions/${timestamp}.jsonl`,
  source: "saved",
});

const record = (text: string) => prepareHistoryRecord(item(text), 0);
const normalizedQuery = (text: string) => normalizeHistorySearchText(text).text;

const candidate = (
  text: string,
  tier: RankedHistoryCandidate["matchTier"],
  options: {
    readonly timestamp?: number;
    readonly fuzzyQuality?: number;
    readonly focusStart?: number;
    readonly focusEnd?: number;
  } = {},
): RankedHistoryCandidate => {
  const focusRange = {
    start: options.focusStart ?? 0,
    end: options.focusEnd ?? text.length,
  };
  return {
    recordId: 0,
    item: item(text, options.timestamp),
    matchTier: tier,
    fuzzyQuality: options.fuzzyQuality,
    matchEvidence: { sourceRanges: [focusRange], focusRange },
  };
};

describe("history search adapter", () => {
  it("prepares records identically across cooperative chunks", async () => {
    const source = item(
      `${"x".repeat(4_095)}\r\nCafe\u0301 ${"word ".repeat(2_000)}`,
    );

    const cooperative = await Effect.runPromise(
      prepareHistoryRecordCooperatively(source, 7),
    );

    expect(cooperative).toEqual(prepareHistoryRecord(source, 7));
  });

  it.each([
    ["CAFÉ", "cafe", "exact"],
    ["prefix beta suffix", "BÉTA", "word-boundary"],
    ["alphabet", "pha", "substring"],
  ] as const)("classifies %j / %j as %s", (text, query, tier) => {
    expect(
      findDirectMatch(record(text), normalizedQuery(query))?.matchTier,
    ).toBe(tier);
  });

  it("uses the earliest best direct occurrence and maps it to raw text", () => {
    expect(
      findDirectMatch(record("É beta BETA"), normalizedQuery("beta"))
        ?.matchEvidence,
    ).toEqual({
      sourceRanges: [{ start: 2, end: 6 }],
      focusRange: { start: 2, end: 6 },
    });
  });

  it("prefers a later word-boundary occurrence over an earlier substring", () => {
    expect(
      findDirectMatch(record("alphabet pha"), normalizedQuery("pha")),
    ).toMatchObject({
      matchTier: "word-boundary",
      matchEvidence: {
        sourceRanges: [{ start: 9, end: 12 }],
        focusRange: { start: 9, end: 12 },
      },
    });
  });

  it.each([
    ["𐄀beta", "word-boundary", 2],
    ["😀beta", "substring", 2],
    ["😀beta 𐄀beta", "word-boundary", 9],
  ] as const)(
    "classifies a match after a Unicode code point in %j as %s",
    (text, matchTier, rawStart) => {
      expect(
        findDirectMatch(record(text), normalizedQuery("beta")),
      ).toMatchObject({
        matchTier,
        matchEvidence: {
          focusRange: { start: rawStart, end: rawStart + 4 },
        },
      });
    },
  );

  it("does not slice growing prefixes for repeated non-boundary occurrences", () => {
    const prepared = record(`x${"a".repeat(20_000)}`);
    const slice = vi.spyOn(String.prototype, "slice");
    let result: RankedHistoryCandidate | undefined;
    let sliceCalls: number;
    try {
      result = findDirectMatch(prepared, "a");
      sliceCalls = slice.mock.calls.length;
    } finally {
      slice.mockRestore();
    }

    expect(sliceCalls).toBe(0);
    expect(result).toMatchObject({
      matchTier: "substring",
      matchEvidence: { focusRange: { start: 1, end: 2 } },
    });
  });

  it("finds smart fuzzy words in either query order", () => {
    const prepared = prepareFuzzyBatch(record("deploy blue widget").segments);
    expect(findFuzzyBatchMatches(prepared, "widget dep")).toHaveLength(1);
    expect(findFuzzyBatchMatches(prepared, "zzzz poor scattered")).toEqual([]);
  });

  it("maps inclusive Microfuzz ranges to ordered half-open raw ranges", () => {
    const prepared = prepareFuzzyBatch(record("café blue").segments);
    const [match] = findFuzzyBatchMatches(prepared, "cafe bl");
    expect(match?.matchEvidence.sourceRanges).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 7 },
    ]);
    expect(match?.matchEvidence.focusRange).toEqual({ start: 0, end: 7 });
  });

  it.each([
    ["at the locality limit", 256, 1],
    ["beyond the locality limit", 257, 0],
  ] as const)(
    "accepts single-token fuzzy evidence %s",
    (_label, span, count) => {
      const source = record("x".repeat(span));
      const segment = source.segments[0];
      if (segment === undefined) throw new Error("source segment missing");
      const prepared = prepareFuzzyBatch(source.segments, () => () => [
        {
          item: segment,
          score: 1,
          matches: [[[0, span - 1]]],
        },
      ]);

      expect(findFuzzyBatchMatches(prepared, "x")).toHaveLength(count);
    },
  );

  it.each([
    ["at the locality limit", 254, 1],
    ["beyond the locality limit", 255, 0],
  ] as const)(
    "accepts combined-token fuzzy evidence %s",
    (_label, middleLength, count) => {
      const text = `a${"x".repeat(middleLength)}b`;
      const source = record(text);
      const segment = source.segments[0];
      if (segment === undefined) throw new Error("source segment missing");
      const prepared = prepareFuzzyBatch(source.segments, () => (token) => [
        {
          item: segment,
          score: 1,
          matches: [
            [
              [
                token === "a" ? 0 : text.length - 1,
                token === "a" ? 0 : text.length - 1,
              ],
            ],
          ],
        },
      ]);

      expect(findFuzzyBatchMatches(prepared, "a b")).toHaveLength(count);
    },
  );

  it("discards malformed scores and ranges at the adapter boundary", () => {
    const alpha = record("alpha");
    const segment = alpha.segments[0];
    if (segment === undefined) throw new Error("alpha segment missing");
    const prepared = prepareFuzzyBatch(alpha.segments, () => () => [
      { item: segment, score: Number.NaN, matches: [[[0, 4]]] },
      { item: segment, score: 1, matches: [[[4, 99]]] },
    ]);
    expect(findFuzzyBatchMatches(prepared, "alpha")).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["over-limit", "a".repeat(HISTORY_SEARCH_LIMITS.fuzzyQueryCodeUnits + 1)],
  ])("does not search an %s normalized fuzzy query", (_label, query) => {
    const search = vi.fn(() => []);
    const prepared = prepareFuzzyBatch(record("alpha").segments, () => search);

    expect(findFuzzyBatchMatches(prepared, query)).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects fuzzy batches above the 64-segment limit", () => {
    const segment = record("alpha").segments[0];
    if (segment === undefined) throw new Error("alpha segment missing");
    expect(() =>
      prepareFuzzyBatch(
        Array.from(
          { length: HISTORY_SEARCH_LIMITS.batchSize + 1 },
          () => segment,
        ),
      ),
    ).toThrow(RangeError);
  });

  it("keeps Microfuzz construction behind this adapter", () => {
    const prepare = vi.fn(() => () => []);
    prepareFuzzyBatch(record("alpha").segments, prepare);
    expect(prepare).toHaveBeenCalledOnce();
  });
});

describe("history search candidate comparators", () => {
  it.each([
    [
      "stronger tier",
      candidate("substring", "substring", { timestamp: 1 }),
      candidate("boundary", "word-boundary", { timestamp: 1 }),
    ],
    [
      "lower fuzzy quality",
      candidate("poor", "fuzzy", { fuzzyQuality: 2 }),
      candidate("good", "fuzzy", { fuzzyQuality: 1 }),
    ],
    [
      "newer timestamp",
      candidate("old", "substring", { timestamp: 1 }),
      candidate("new", "substring", { timestamp: 2 }),
    ],
    [
      "lexically earlier text",
      candidate("zeta", "substring", { timestamp: 1 }),
      candidate("alpha", "substring", { timestamp: 1 }),
    ],
  ])("compareRankedCandidates orders by %s", (_label, weaker, stronger) => {
    expect(compareRankedCandidates(stronger, weaker)).toBeLessThan(0);
    expect(compareRankedCandidates(weaker, stronger)).toBeGreaterThan(0);
  });

  it.each([
    [
      "lower fuzzy quality",
      candidate("same", "fuzzy", {
        fuzzyQuality: 2,
        focusStart: 1,
        focusEnd: 3,
      }),
      candidate("same", "fuzzy", {
        fuzzyQuality: 1,
        focusStart: 5,
        focusEnd: 9,
      }),
    ],
    [
      "shorter focus",
      candidate("same", "fuzzy", {
        fuzzyQuality: 1,
        focusStart: 1,
        focusEnd: 5,
      }),
      candidate("same", "fuzzy", {
        fuzzyQuality: 1,
        focusStart: 4,
        focusEnd: 6,
      }),
    ],
    [
      "earlier focus",
      candidate("same", "fuzzy", {
        fuzzyQuality: 1,
        focusStart: 5,
        focusEnd: 7,
      }),
      candidate("same", "fuzzy", {
        fuzzyQuality: 1,
        focusStart: 2,
        focusEnd: 4,
      }),
    ],
  ])(
    "compareSameMessageFuzzyEvidence orders by %s",
    (_label, weaker, stronger) => {
      expect(compareSameMessageFuzzyEvidence(stronger, weaker)).toBeLessThan(0);
      expect(compareSameMessageFuzzyEvidence(weaker, stronger)).toBeGreaterThan(
        0,
      );
    },
  );
});
