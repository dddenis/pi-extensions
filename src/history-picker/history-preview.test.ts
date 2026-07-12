import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { projectHistoryPreview } from "./history-preview";
import type { HistoryMatchEvidence } from "./types";

// eslint-disable-next-line no-control-regex -- The invariant rejects terminal control input.
const forbiddenTerminalInput = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const loneSurrogate =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const evidence = (start: number, end: number): HistoryMatchEvidence => ({
  sourceRanges: [{ start, end }],
  focusRange: { start, end },
});

const projectWithInvariantChecks = (
  raw: string,
  evidence: HistoryMatchEvidence | undefined,
  width: number,
): string => {
  const before = raw;
  const budget = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const output = projectHistoryPreview(raw, evidence, width);
  expect(output).not.toMatch(forbiddenTerminalInput);
  expect(output).not.toMatch(loneSurrogate);
  expect(visibleWidth(output)).toBeLessThanOrEqual(budget);
  expect(raw).toBe(before);
  return output;
};

const expectSafeProjection = (
  raw: string,
  evidence: HistoryMatchEvidence | undefined,
  width: number,
  expected: string,
): string => {
  const output = projectWithInvariantChecks(raw, evidence, width);
  expect(output).toBe(expected);
  return output;
};

describe("projectHistoryPreview", () => {
  it.each([
    ["a\r\n\r\n\nb", "a↵b"],
    ["a\rb\nc\u2028d\u2029e", "a↵b↵c↵d↵e"],
    ["alpha\t  beta\u00a0gamma", "alpha beta gamma"],
    ["\u0000\u0001\u007f", "�"],
    ["\x1b[31mred\x1b[0m", "�[31mred�[0m"],
    ["\x1b]0;owned\x07safe", "�]0;owned�safe"],
    ["\ud800", "�"],
    ["e\u0301 中文 👨‍👩‍👧‍👦", "e\u0301 中文 👨‍👩‍👧‍👦"],
  ])("normalizes %j into one safe line", (raw, expected) => {
    expectSafeProjection(raw, undefined, 80, expected);
  });

  it("returns the safest value for empty, zero, and narrow inputs", () => {
    expectSafeProjection("", undefined, 10, "");
    expectSafeProjection("hello", undefined, 0, "");
    expectSafeProjection("hello", undefined, Number.NaN, "");
    expectSafeProjection("hello", undefined, 1, "…");
    expectSafeProjection("界", undefined, 1, "…");
  });

  it("centers a match that exists only on a later line", () => {
    const raw =
      "old context that should be omitted\nneedle appears here\ntrailing context";
    const start = raw.indexOf("needle");
    const output = projectWithInvariantChecks(
      raw,
      evidence(start, start + 6),
      24,
    );
    expect(output).toContain("needle");
    expect(output).toContain("↵");
    expect(output).toMatch(/^…/u);
  });

  it("keeps a fuzzy focus spanning a line boundary safe", () => {
    const raw = "before mat\nch after";
    const output = projectWithInvariantChecks(raw, evidence(7, 13), 20);
    expect(output).toContain("mat↵ch");
  });

  it("reassigns unused context cells to the non-exhausted side", () => {
    const raw = "hit followed by enough trailing context";
    const output = projectWithInvariantChecks(raw, evidence(0, 3), 16);
    expect(output.startsWith("hit")).toBe(true);
    expect(output.startsWith("…")).toBe(false);
  });

  it("does not reassign a blocked context half before that side is exhausted", () => {
    const raw = "界fabcdef";

    expectSafeProjection(raw, evidence(1, 2), 6, "…fab…");
  });

  it("shows the beginning of an oversized focus with trailing omission", () => {
    const raw = "before abcdefghijklmnopqrstuvwxyz after";
    const start = raw.indexOf("abcdefghijklmnopqrstuvwxyz");
    const output = projectWithInvariantChecks(
      raw,
      evidence(start, start + 26),
      10,
    );
    expect(output).toContain("abc");
    expect(output.endsWith("…")).toBe(true);
  });

  it("ends a truncated focus at the raw edge with an omission marker", () => {
    const raw = "abcdefghijklmnopqrstuvwxyz";
    expectSafeProjection(raw, evidence(0, raw.length), 5, "abcd…");
  });

  it("retains both omission markers around a truncated later focus", () => {
    const raw = "before abcdefghijklmnopqrstuvwxyz";
    const start = raw.indexOf("abcdefghijklmnopqrstuvwxyz");
    expectSafeProjection(raw, evidence(start, raw.length), 5, "…abc…");
  });

  it.each([
    undefined,
    { sourceRanges: [], focusRange: { start: -100, end: -10 } },
    { sourceRanges: [], focusRange: { start: 9, end: 2 } },
    { sourceRanges: [], focusRange: { start: Number.NaN, end: 2 } },
  ])(
    "falls back to the beginning for missing or invalid evidence",
    (matchEvidence) => {
      expect(
        projectWithInvariantChecks("alpha beta gamma", matchEvidence, 10),
      ).toMatch(/^alpha/u);
    },
  );

  it.each([
    { raw: "prefix e\u0301 suffix", focus: "e\u0301", width: 8 },
    { raw: "前文 目标 后文", focus: "目标", width: 8 },
    { raw: "left 👨‍👩‍👧‍👦 right", focus: "👨‍👩‍👧‍👦", width: 8 },
  ])("keeps the complete focused grapheme in $raw", ({ raw, focus, width }) => {
    const start = raw.indexOf(focus);
    const output = projectWithInvariantChecks(
      raw,
      evidence(start, start + focus.length),
      width,
    );
    expect(output).toContain(focus);
  });

  it("marks leading and trailing omissions independently", () => {
    const raw = "leading context focus trailing context";
    const start = raw.indexOf("focus");
    const output = projectWithInvariantChecks(
      raw,
      evidence(start, start + 5),
      9,
    );
    expect(output.startsWith("…")).toBe(true);
    expect(output.endsWith("…")).toBe(true);
  });

  it("never segments an entire very large prompt", () => {
    const raw = `${"x".repeat(1_000_000)} needle ${"y".repeat(1_000_000)}`;
    const start = raw.indexOf("needle");
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");

    const output = projectWithInvariantChecks(
      raw,
      evidence(start, start + 6),
      40,
    );

    expect(output).toContain("needle");
    expect(segment).toHaveBeenCalled();
    expect(
      Math.max(...segment.mock.calls.map(([value]) => String(value).length)),
    ).toBeLessThanOrEqual(Math.max(256, 40 * 32));
    segment.mockRestore();
  });

  it("expands to the cap before degrading an adversarial focus", () => {
    const raw = `before a${"\u0301".repeat(300)} after`;
    const start = raw.indexOf("a");
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");

    expectSafeProjection(raw, evidence(start, start + 301), 1, "…");
    expect(
      Math.max(...segment.mock.calls.map(([value]) => String(value).length)),
    ).toBe(256);
    segment.mockRestore();
  });

  it("stops expansion when all compressed available context fits", () => {
    const raw = `${"\u0001".repeat(1_000_000)}tail`;
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");

    projectWithInvariantChecks(raw, undefined, 20);

    expect(
      Math.max(...segment.mock.calls.map(([value]) => String(value).length)),
    ).toBe(80);
    segment.mockRestore();
  });

  it("caps expansion through a very large control run", () => {
    const raw = `${"\u0001".repeat(1_000_000)}tail`;
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");

    const output = projectWithInvariantChecks(raw, undefined, 20);

    expect(output).toMatch(/�|…/u);
    expect(
      Math.max(...segment.mock.calls.map(([value]) => String(value).length)),
    ).toBeLessThanOrEqual(Math.max(256, 20 * 32));
    segment.mockRestore();
  });
});
