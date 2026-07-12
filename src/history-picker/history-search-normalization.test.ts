import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_SEARCH_LIMITS,
  normalizeHistorySearchText,
  normalizeHistorySearchTextCooperatively,
  segmentHistorySearchText,
  segmentHistorySearchTextCooperatively,
  type HistorySearchCheckpoint,
  type HistorySearchBreak,
} from "./history-search-normalization";

const ranges = (raw: string) =>
  normalizeHistorySearchText(raw).sourceByCodeUnit.map(({ start, end }) => [
    start,
    end,
  ]);

describe("history search normalization", () => {
  it.each([
    ["CAFÉ", "cafe"],
    ["Cafe\u0301", "cafe"],
    ["İ Ł Ñ", "i l n"],
    ["A\n\t\u001bb", "a b"],
    ["中文 😀", "中文 😀"],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeHistorySearchText(raw).text).toBe(expected);
  });

  it("preserves normalization exactly across cooperative chunks", async () => {
    const raw = `${"a".repeat(4_095)}\r\n😀 Cafe\u0301 ${"z ".repeat(4_096)}`;

    const cooperative = await Effect.runPromise(
      normalizeHistorySearchTextCooperatively(raw),
    );

    expect(cooperative).toEqual(normalizeHistorySearchText(raw));
  });

  it("yields after raw traversal before oversized finalization completes", async () => {
    const chunkCount = 128;
    const raw = "a".repeat(4_096 * chunkCount);
    let checkpointCount = 0;
    let completed = false;
    let observeCompletion: ((completed: boolean) => void) | undefined;
    const observedCompletion = new Promise<boolean>((resolve) => {
      observeCompletion = resolve;
    });
    const checkpoint: HistorySearchCheckpoint = () => {
      checkpointCount += 1;
      if (checkpointCount === chunkCount) {
        setTimeout(() => observeCompletion?.(completed), 0);
        return Effect.yieldNow();
      }
      return checkpointCount === chunkCount + 1
        ? Effect.sleep("0 millis")
        : Effect.yieldNow();
    };
    const normalization = Effect.runPromise(
      normalizeHistorySearchTextCooperatively(raw, checkpoint),
    ).finally(() => {
      completed = true;
    });

    expect(await observedCompletion).toBe(false);
    await normalization;
  });

  it("maps expansions, combining marks, and emoji to complete raw ranges", () => {
    expect(ranges("İ")).toEqual([[0, 1]]);
    expect(ranges("e\u0301")).toEqual([[0, 2]]);
    expect(ranges("😀")).toEqual([
      [0, 2],
      [0, 2],
    ]);
  });

  it("collapses and trims searchable whitespace while retaining its raw span", () => {
    const normalized = normalizeHistorySearchText("  a\r\n\t\u001b b  ");
    expect(normalized.text).toBe("a b");
    expect(normalized.sourceByCodeUnit[1]).toEqual({ start: 3, end: 8 });
    expect(normalized.breakAfter.get(2)).toBe("line");
  });

  it("keeps collapsing whitespace across an independent combining mark", () => {
    expect(normalizeHistorySearchText("a \u0301 b").text).toBe("a b");
  });

  it("preserves source ranges across cooperative chunk boundaries", async () => {
    const surrogateRaw = `${"a".repeat(4_095)}😀`;
    const surrogate = await Effect.runPromise(
      normalizeHistorySearchTextCooperatively(surrogateRaw),
    );
    expect(surrogate.text.slice(-2)).toBe("😀");
    expect(surrogate.sourceByCodeUnit.slice(-2)).toEqual([
      { start: 4_095, end: 4_097 },
      { start: 4_095, end: 4_097 },
    ]);

    const combiningRaw = `${"a".repeat(4_095)}e\u0301`;
    const combining = await Effect.runPromise(
      normalizeHistorySearchTextCooperatively(combiningRaw),
    );
    expect(combining.text.slice(-1)).toBe("e");
    expect(combining.sourceByCodeUnit.at(-1)).toEqual({
      start: 4_095,
      end: 4_097,
    });

    const crlfRaw = `${"a".repeat(4_095)}\r\nb`;
    const crlf = await Effect.runPromise(
      normalizeHistorySearchTextCooperatively(crlfRaw),
    );
    expect(crlf.text.slice(-2)).toBe(" b");
    expect(crlf.sourceByCodeUnit.at(-2)).toEqual({
      start: 4_095,
      end: 4_097,
    });
    expect(crlf.breakAfter.get(4_096)).toBe("line");
  });

  it("never emits a source range inside a raw code point", () => {
    const raw = "😀e\u0301中文";
    const isBoundary = (index: number): boolean => {
      if (index <= 0 || index >= raw.length) return true;
      const current = raw.charCodeAt(index);
      const previous = raw.charCodeAt(index - 1);
      const startsOnLowSurrogate = current >= 0xdc00 && current <= 0xdfff;
      const followsHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
      return !(startsOnLowSurrogate && followsHighSurrogate);
    };
    const normalized = normalizeHistorySearchText(raw);
    for (const range of normalized.sourceByCodeUnit) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeGreaterThan(range.start);
      expect(range.end).toBeLessThanOrEqual(raw.length);
      expect(isBoundary(range.start)).toBe(true);
      expect(isBoundary(range.end)).toBe(true);
    }
  });
});

describe("history search segmentation", () => {
  it("overlaps every hard cut by the fuzzy evidence span", () => {
    const normalized = normalizeHistorySearchText("x".repeat(1_200));
    const segments = segmentHistorySearchText(normalized);

    expect(segments.map((segment) => segment.text.length)).toEqual([
      512, 512, 512, 432,
    ]);
    expect(segments.map((segment) => segment.normalizedStart)).toEqual([
      0, 256, 512, 768,
    ]);
    expect(HISTORY_SEARCH_LIMITS.segmentOverlapCodeUnits).toBe(
      HISTORY_SEARCH_LIMITS.fuzzyEvidenceSpanCodeUnits,
    );
  });

  it("prefers a line, then sentence, then whitespace in the final overlap window", () => {
    const prefix = "x".repeat(450);
    const normalized = normalizeHistorySearchText(
      `${prefix} word. more\nlast ${"z".repeat(100)}`,
    );
    const [first, second] = segmentHistorySearchText(normalized);
    expect(first?.text.endsWith("more ")).toBe(true);
    expect(second?.normalizedStart).toBe(
      (first?.normalizedEnd ?? 0) -
        HISTORY_SEARCH_LIMITS.segmentOverlapCodeUnits,
    );
  });

  it.each([
    ["line", `${"x".repeat(479)}\n${"x".repeat(240)}`, 480],
    ["sentence", `${"x".repeat(478)}. ${"x".repeat(240)}`, 480],
    ["whitespace", `${"x".repeat(479)} ${"x".repeat(240)}`, 480],
    ["hard", "x".repeat(720), 512],
  ] as const)(
    "keeps synchronous and cooperative %s-cut windows equivalent",
    async (_kind, raw, expectedCut) => {
      const normalized = normalizeHistorySearchText(raw);
      const synchronous = segmentHistorySearchText(normalized);
      const cooperative = await Effect.runPromise(
        segmentHistorySearchTextCooperatively(normalized),
      );

      expect(cooperative).toEqual(synchronous);
      expect(synchronous[0]?.normalizedEnd).toBe(expectedCut);
      expect(synchronous[1]?.normalizedStart).toBe(
        expectedCut - HISTORY_SEARCH_LIMITS.segmentOverlapCodeUnits,
      );
    },
  );

  it("retains bounded raw source endpoints for every segment", () => {
    const raw = `${"é".repeat(600)}😀tail`;
    for (const segment of segmentHistorySearchText(
      normalizeHistorySearchText(raw),
    )) {
      expect(segment.text.length).toBeLessThanOrEqual(512);
      expect(segment.rawStart).toBeGreaterThanOrEqual(0);
      expect(segment.rawEnd).toBeLessThanOrEqual(raw.length);
      expect(segment.rawEnd).toBeGreaterThan(segment.rawStart);
    }
  });

  it.each([
    [
      "line over later sentence and whitespace",
      new Map<number, HistorySearchBreak>([
        [449, "line"],
        [450, "line"],
        [510, "sentence"],
        [512, "whitespace"],
      ]),
      450,
    ],
    [
      "sentence over later whitespace",
      new Map<number, HistorySearchBreak>([
        [509, "sentence"],
        [510, "sentence"],
        [512, "whitespace"],
      ]),
      510,
    ],
    [
      "last whitespace",
      new Map<number, HistorySearchBreak>([
        [509, "whitespace"],
        [511, "whitespace"],
      ]),
      511,
    ],
  ] as const)("selects the %s position", (_label, breakAfter, expected) => {
    const normalized = normalizeHistorySearchText("x".repeat(600));
    const first = segmentHistorySearchText({
      ...normalized,
      breakAfter,
    })[0];
    expect(first?.normalizedEnd).toBe(expected);
  });

  it("inspects only the preferred-cut lookback window", () => {
    const normalized = normalizeHistorySearchText("a ".repeat(20_000));
    const breakAfter = new Map(normalized.breakAfter);
    const get = vi.spyOn(breakAfter, "get");
    const iterate = vi.spyOn(breakAfter, Symbol.iterator);

    const segments = segmentHistorySearchText({ ...normalized, breakAfter });

    expect(segments.length).toBeGreaterThan(64);
    expect(iterate).not.toHaveBeenCalled();
    expect(get.mock.calls.length).toBeLessThanOrEqual(
      (segments.length - 1) *
        HISTORY_SEARCH_LIMITS.preferredCutLookbackCodeUnits,
    );
  });
});
