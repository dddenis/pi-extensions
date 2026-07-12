import { describe, expect, it } from "vitest";
import { HistoryPickerState, resultWindow } from "./picker-state";
import type { HistoryItem, HistorySearchSnapshot } from "./types";

const item = (
  text: string,
  timestamp: number,
  cwd = "/project-a",
): HistoryItem => ({
  text,
  timestamp,
  cwd,
  sessionFile: `/sessions/${text}.jsonl`,
  source: "saved",
});

const searchSnapshot = (
  items: ReadonlyArray<HistoryItem>,
  overrides: Partial<HistorySearchSnapshot> = {},
): HistorySearchSnapshot => ({
  results: items.map((historyItem) => ({ item: historyItem })),
  hasMoreResults: false,
  searching: false,
  ...overrides,
});

describe("history picker state", () => {
  it("keeps a moving window of at most the requested size", () => {
    expect(resultWindow(20, 0, 12)).toEqual({ start: 0, end: 12 });
    expect(resultWindow(20, 11, 12)).toEqual({ start: 0, end: 12 });
    expect(resultWindow(20, 12, 12)).toEqual({ start: 1, end: 13 });
    expect(resultWindow(20, 19, 12)).toEqual({ start: 8, end: 20 });
  });

  it("starts with the supplied query, search snapshot, and all-project scope", () => {
    const initialSearch = searchSnapshot([item("alpha", 1)], {
      hasMoreResults: true,
      searching: true,
      warning: "partial search",
    });
    const state = new HistoryPickerState({
      initialQuery: "alp",
      initialSearch,
    });

    expect(state.query).toBe("alp");
    expect(state.scope).toBe("all");
    expect(state.results.map((result) => result.item.text)).toEqual(["alpha"]);
    expect(state.hasMoreResults).toBe(true);
    expect(state.searching).toBe(true);
    expect(state.warning).toBe("partial search");
    expect(state.selectedIndex).toBe(0);
  });

  it("updates query immediately while retaining prior results", () => {
    const alpha = item("alpha", 1);
    const state = new HistoryPickerState({
      initialQuery: "",
      initialSearch: searchSnapshot([alpha]),
    });

    state.setQuery("new query");

    expect(state.query).toBe("new query");
    expect(state.results[0]?.item).toEqual(alpha);
  });

  it("toggles project scope, resets selection, and retains prior results", () => {
    const initialSearch = searchSnapshot([
      item("newest elsewhere", 30, "/project-b"),
      item("here", 20),
    ]);
    const state = new HistoryPickerState({
      initialQuery: "",
      initialSearch,
    });
    state.moveSelection(1);

    state.toggleScope();

    expect(state.scope).toBe("current-project");
    expect(state.selectedIndex).toBe(0);
    expect(state.results).toEqual(initialSearch.results);

    state.toggleScope();
    expect(state.scope).toBe("all");
    expect(state.selectedIndex).toBe(0);
    expect(state.results).toEqual(initialSearch.results);
  });

  it("atomically replaces results and clamps selection", () => {
    const state = new HistoryPickerState({
      initialQuery: "",
      initialSearch: searchSnapshot([
        item("one", 3),
        item("two", 2),
        item("three", 1),
      ]),
    });
    state.moveSelection(2);

    state.setSearchSnapshot(searchSnapshot([item("only", 4)]));

    expect(state.selectedIndex).toBe(0);
    expect(state.selectedResult?.item.text).toBe("only");

    state.setSearchSnapshot(searchSnapshot([]));
    expect(state.selectedIndex).toBe(0);
    expect(state.selectedResult).toBeUndefined();
  });

  it("copies replacement snapshots including match evidence", () => {
    const source = searchSnapshot([item("alpha", 1)]);
    const range = { start: 0, end: 2 };
    const replacement: HistorySearchSnapshot = {
      results: [
        {
          item: item("replacement", 2),
          matchTier: "substring",
          matchEvidence: { sourceRanges: [range], focusRange: range },
        },
      ],
      hasMoreResults: true,
      searching: true,
      warning: "warning",
    };
    const state = new HistoryPickerState({
      initialQuery: "",
      initialSearch: source,
    });

    state.setSearchSnapshot(replacement);
    const mutableRange = replacement.results[0]?.matchEvidence?.sourceRanges[0];
    if (mutableRange !== undefined) {
      Object.assign(mutableRange, { start: 99 });
    }

    expect(state.results[0]?.matchEvidence?.sourceRanges[0]?.start).toBe(0);
    expect(state.hasMoreResults).toBe(true);
    expect(state.searching).toBe(true);
    expect(state.warning).toBe("warning");
  });

  it("keeps the selected result inside the visible window", () => {
    const state = new HistoryPickerState({
      initialQuery: "",
      initialSearch: searchSnapshot(
        Array.from({ length: 20 }, (_, index) =>
          item(`item-${index}`, 20 - index),
        ),
      ),
    });
    state.moveSelection(12);

    const window = state.resultWindow(12);
    expect(window).toEqual({ start: 1, end: 13 });
    expect(state.selectedIndex).toBeGreaterThanOrEqual(window.start);
    expect(state.selectedIndex).toBeLessThan(window.end);
  });
});
