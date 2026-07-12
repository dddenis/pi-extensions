import {
  CURSOR_MARKER,
  type Keybinding,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { historyPickerOverlayRows } from "./layout";
import { HistoryPickerComponent } from "./picker";
import type {
  HistoryItem,
  HistorySearchSnapshot,
  HistorySnapshot,
} from "./types";

const item = (
  text: string,
  timestamp: number,
  cwd = "/project",
): HistoryItem => ({
  text,
  timestamp,
  cwd,
  sessionFile: `/sessions/${text}.jsonl`,
  source: "saved",
});

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

// eslint-disable-next-line no-control-regex -- Result rows must not contain terminal controls.
const forbiddenLineOrControl = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const forbiddenLogicalLineBreak = /[\r\n\u2028\u2029]/u;

const expectSafeRender = (
  lines: ReadonlyArray<string>,
  width: number,
): void => {
  for (const line of lines) {
    expect(line).not.toMatch(forbiddenLogicalLineBreak);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    if (line.startsWith("> ") || line.startsWith("  ")) {
      expect(line).not.toMatch(forbiddenLineOrControl);
    }
  }
};

const makeKeybindings = (bindings: Readonly<Record<string, Keybinding>>) => ({
  matches: (data: string, binding: Keybinding) => bindings[data] === binding,
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

const makeComponent = (
  overrides: {
    readonly items?: ReadonlyArray<HistoryItem>;
    readonly initialQuery?: string;
    readonly initialSearch?: HistorySearchSnapshot;
    readonly snapshot?: HistorySnapshot;
    readonly bindings?: Readonly<Record<string, Keybinding>>;
    readonly terminalRows?: number;
  } = {},
) => {
  const requestRender = vi.fn();
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const replaceItems = vi.fn();
  const search = vi.fn();
  const currentItems = overrides.items ?? [item("alpha", 2), item("beta", 1)];
  const snapshot = overrides.snapshot ?? { savedItems: [], loading: false };
  const initialSearch =
    overrides.initialSearch ??
    searchSnapshot(
      [...currentItems, ...snapshot.savedItems].sort(
        (left, right) => right.timestamp - left.timestamp,
      ),
    );
  let terminalRows = overrides.terminalRows ?? 24;
  const component = new HistoryPickerComponent({
    viewport: {
      requestRender,
      terminalRows: () => terminalRows,
    },
    theme,
    keybindings: makeKeybindings(
      overrides.bindings ?? {
        CANCEL: "tui.select.cancel",
        CONFIRM: "tui.select.confirm",
        UP: "tui.select.up",
        DOWN: "tui.select.down",
      },
    ),
    searchPort: { replaceItems, search },
    currentItems,
    snapshot,
    initialSearch,
    initialQuery: overrides.initialQuery ?? "",
    currentCwd: "/project",
    onSelect,
    onCancel,
  });
  return {
    component,
    requestRender,
    onSelect,
    onCancel,
    replaceItems,
    search,
    setTerminalRows: (rows: number) => {
      terminalRows = rows;
    },
  };
};

const resultLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => line.startsWith("> ") || line.startsWith("  "));

describe("HistoryPickerComponent", () => {
  it("uses configured cancel, confirm, up, and down bindings", () => {
    const { component, onCancel, onSelect, requestRender } = makeComponent();

    component.handleInput("DOWN");
    component.handleInput("UP");
    component.handleInput("DOWN");
    component.handleInput("CONFIRM");
    component.handleInput("CANCEL");

    expect(onSelect).toHaveBeenCalledWith("beta");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalledTimes(3);
  });

  it("requests initial search before replacing the complete item snapshot", () => {
    const current = item("current", 2);
    const saved = item("saved", 1);
    const { search, replaceItems } = makeComponent({
      items: [current],
      snapshot: { savedItems: [saved], loading: false },
    });

    expect(search).toHaveBeenCalledWith({
      query: "",
      scope: "all",
      currentCwd: "/project",
    });
    expect(replaceItems).toHaveBeenCalledWith([current, saved]);
    expect(search.mock.invocationCallOrder[0]).toBeLessThan(
      replaceItems.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("updates query immediately, requests search, and retains prior results", () => {
    const initialSearch = searchSnapshot([item("alpha", 2)]);
    const { component, requestRender, search } = makeComponent({
      initialSearch,
    });
    search.mockClear();

    component.handleInput("z");

    expect(component.query).toBe("z");
    expect(search).toHaveBeenLastCalledWith({
      query: "z",
      scope: "all",
      currentCwd: "/project",
    });
    expect(component.results).toEqual(initialSearch.results);
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("resets selection and requests the new scope while retaining results", () => {
    const initialSearch = searchSnapshot([item("alpha", 2), item("beta", 1)]);
    const { component, requestRender, search } = makeComponent({
      initialSearch,
    });
    component.handleInput("DOWN");
    search.mockClear();
    requestRender.mockClear();

    component.handleInput("\x10");

    expect(component.scope).toBe("current-project");
    expect(component.selectedIndex).toBe(0);
    expect(component.results).toEqual(initialSearch.results);
    expect(search).toHaveBeenLastCalledWith({
      query: "",
      scope: "current-project",
      currentCwd: "/project",
    });
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("starts a non-empty initial query with the cursor at its end", () => {
    const { component } = makeComponent({ initialQuery: "prefilled" });

    component.focused = true;
    const searchLine =
      component.render(80).find((line) => line.startsWith("Search: ")) ?? "";
    const markerIndex = searchLine.indexOf(CURSOR_MARKER);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(searchLine.slice(0, markerIndex)).toMatch(/prefilled$/);

    component.handleInput("z");
    expect(component.query).toBe("prefilledz");

    component.handleInput("\x1b[45;5u");
    expect(component.query).toBe("prefilled");

    component.handleInput("x");
    expect(component.query).toBe("prefilledx");
  });

  it("propagates focus to its nested Input for IME cursor placement", () => {
    const { component, requestRender } = makeComponent({ initialQuery: "a" });

    component.focused = true;
    expect(component.render(40).join("\n")).toContain(CURSOR_MARKER);
    component.focused = false;
    expect(component.render(40).join("\n")).not.toContain(CURSOR_MARKER);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("replaces search publications atomically, clamps selection, and renders once", () => {
    const { component, requestRender } = makeComponent({
      initialSearch: searchSnapshot([
        item("one", 3),
        item("two", 2),
        item("three", 1),
      ]),
    });
    component.handleInput("DOWN");
    component.handleInput("DOWN");
    requestRender.mockClear();

    component.setSearchSnapshot(searchSnapshot([item("only", 4)]));

    expect(component.selectedIndex).toBe(0);
    expect(component.results[0]?.item.text).toBe("only");
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("replaces service items after saved publication while retaining results", () => {
    const initialSearch = searchSnapshot([item("prior result", 2)]);
    const current = item("current", 1);
    const saved = item("saved", 10);
    const { component, requestRender, replaceItems } = makeComponent({
      items: [current],
      initialSearch,
    });
    replaceItems.mockClear();

    component.setSavedSnapshot({
      savedItems: [saved],
      loading: false,
      warning: "partial",
    });

    expect(replaceItems).toHaveBeenCalledWith([current, saved]);
    expect(component.results).toEqual(initialSearch.results);
    const lines = component.render(80);
    expect(lines.join("\n")).toContain("prior result");
    expect(lines.join("\n")).toContain("partial");
    expectSafeRender(lines, 80);
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("keeps adversarial snapshot rows safe across movement and mutation", () => {
    const raw = [
      "",
      "\t中文 👨‍👩‍👧‍👦",
      "CSI \x1b[31mred\x1b[0m",
      "OSC \x1b]0;owned\x07safe",
      "",
    ].join("\n");
    const snapshot = {
      savedItems: [item(raw, 10)],
      loading: false,
    };
    const { component } = makeComponent({
      items: [item("ordinary", 1)],
      snapshot,
    });

    expect(component.results[component.selectedIndex]?.item.text).toBe(raw);
    expectSafeRender(component.render(24), 24);

    component.handleInput("DOWN");
    expectSafeRender(component.render(24), 24);
    component.handleInput("UP");
    expect(component.results[component.selectedIndex]?.item.text).toBe(raw);
    expectSafeRender(component.render(24), 24);

    component.setSavedSnapshot(snapshot);
    expect(component.results[component.selectedIndex]?.item.text).toBe(raw);
    expectSafeRender(component.render(24), 24);
  });

  it("truncates every rendered line to the supplied width", () => {
    const { component } = makeComponent({
      items: [item("very long history result with wide text 中文日本語", 1)],
      initialQuery: "a very long query 中文日本語",
      snapshot: {
        savedItems: [],
        loading: false,
        warning: "a warning that is much wider than the viewport",
      },
    });

    expect(component.render(18).every((line) => visibleWidth(line) <= 18)).toBe(
      true,
    );
  });

  it("renders capped result counts as 200+", () => {
    const results = Array.from({ length: 200 }, (_, index) =>
      item(`result-${index}`, 200 - index),
    );
    const { component } = makeComponent({
      items: results,
      initialSearch: searchSnapshot(results, { hasMoreResults: true }),
    });

    expect(component.render(100).join("\n")).toContain("Results: 200+");
  });

  it("renders Searching only when the service snapshot says searching", () => {
    const initialSearch = searchSnapshot([item("result", 1)]);
    const { component } = makeComponent({ initialSearch });

    expect(component.render(80).join("\n")).not.toContain("Searching…");

    component.setSearchSnapshot({ ...initialSearch, searching: true });
    expect(component.render(80).join("\n")).toContain("Searching…");
  });

  it("combines saved loading and searching in the existing status row", () => {
    const { component } = makeComponent({
      snapshot: { savedItems: [], loading: true },
      initialSearch: searchSnapshot([item("result", 1)], { searching: true }),
    });

    const lines = component.render(80);
    expect(lines).toContain("Loading saved sessions… • Searching…");
    expect(lines.filter((line) => line.includes("…"))).toHaveLength(1);
  });

  it("combines saved and search warnings in the existing warning row", () => {
    const { component } = makeComponent({
      snapshot: {
        savedItems: [],
        loading: false,
        warning: "Saved history partial",
      },
      initialSearch: searchSnapshot([item("result", 1)], {
        warning: "Fuzzy history search unavailable",
      }),
    });

    const lines = component.render(80);
    expect(lines).toContain(
      "Saved history partial • Fuzzy history search unavailable",
    );
    expect(lines.filter((line) => line.includes("history"))).toHaveLength(1);
  });

  it("renders a later-line query in one control-safe result row", () => {
    const raw = [
      "write a function:",
      "",
      "const emoji = '👨‍👩‍👧‍👦';",
      "needle is here \x1b[31mred\x1b[0m",
    ].join("\n");
    const historyItem = item(raw, 1);
    const start = raw.indexOf("needle");
    const { component } = makeComponent({
      items: [historyItem],
      initialSearch: {
        results: [
          {
            item: historyItem,
            matchTier: "word-boundary",
            matchEvidence: {
              sourceRanges: [{ start, end: start + "needle".length }],
              focusRange: { start, end: start + "needle".length },
            },
          },
        ],
        hasMoreResults: false,
        searching: false,
      },
    });

    for (const character of "needle") component.handleInput(character);
    const lines = component.render(32);
    const resultLines = lines.filter(
      (line) => line.startsWith("> ") || line.startsWith("  "),
    );

    expect(resultLines).toHaveLength(1);
    expect(resultLines[0]).toContain("needle");
    expectSafeRender(lines, 32);
  });

  it("confirms the exact original multiline message", () => {
    const raw = "  first line\nsecond 👋 line\n  ";
    const { component, onSelect } = makeComponent({ items: [item(raw, 1)] });
    component.handleInput("CONFIRM");
    expect(onSelect).toHaveBeenCalledWith(raw);
  });

  it("renders the selected row after moving past index 12", () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item(`result-${index}`, 20 - index),
    );
    const { component } = makeComponent({ items });

    for (let index = 0; index < 12; index += 1) {
      component.handleInput("DOWN");
    }

    const lines = component.render(80);
    const rendered = lines.join("\n");
    expect(component.selectedIndex).toBe(12);
    expect(rendered).toContain("result-12");
    expect(rendered).not.toContain("result-0");
    expectSafeRender(lines, 80);
  });

  it("keeps selection and picker state while shrinking and growing", () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item(`result-${index}`, 20 - index),
    );
    const { component, setTerminalRows } = makeComponent({
      items,
      initialQuery: "result",
    });
    component.handleInput("\x10");
    for (let index = 0; index < 12; index += 1) {
      component.handleInput("DOWN");
    }

    for (const terminalRows of [24, 18, 15, 10]) {
      setTerminalRows(terminalRows);
      const lines = component.render(80);
      expect(lines.length).toBeLessThanOrEqual(
        historyPickerOverlayRows(terminalRows),
      );
      expect(lines.join("\n")).toContain("result-12");
      expect(component.selectedIndex).toBe(12);
      expect(component.query).toBe("result");
      expect(component.scope).toBe("current-project");
    }

    setTerminalRows(24);
    expect(resultLines(component.render(80))).toHaveLength(12);
    expect(component.selectedIndex).toBe(12);
  });

  it.each([
    { name: "loading", loading: true, warning: undefined },
    { name: "warning", loading: false, warning: "partial history" },
    { name: "loading and warning", loading: true, warning: "partial history" },
  ])(
    "keeps the selected row visible while $name rows degrade",
    ({ loading, warning }) => {
      const items = Array.from({ length: 20 }, (_, index) =>
        item(`status-result-${index}`, 20 - index),
      );
      const { component, setTerminalRows } = makeComponent({
        items,
        snapshot: { savedItems: [], loading, warning },
      });
      for (let index = 0; index < 12; index += 1) {
        component.handleInput("DOWN");
      }

      for (const terminalRows of [18, 15, 10, 6]) {
        setTerminalRows(terminalRows);
        const lines = component.render(80);
        expect(lines.length).toBeLessThanOrEqual(
          historyPickerOverlayRows(terminalRows),
        );
        expect(lines.join("\n")).toContain("status-result-12");
      }
    },
  );

  it("applies a shorter search publication before rendering a short viewport", () => {
    const initialSearch = searchSnapshot(
      Array.from({ length: 20 }, (_, index) =>
        item(`saved-${index}`, 20 - index),
      ),
    );
    const { component, setTerminalRows } = makeComponent({
      items: [],
      initialQuery: "saved",
      initialSearch,
    });
    component.handleInput("\x10");
    for (let index = 0; index < 12; index += 1) {
      component.handleInput("DOWN");
    }

    setTerminalRows(10);
    component.setSearchSnapshot(
      searchSnapshot([item("saved-new", 100), item("saved-old", 99)]),
    );
    const lines = component.render(80);

    expect(component.selectedIndex).toBe(1);
    expect(component.query).toBe("saved");
    expect(component.scope).toBe("current-project");
    expect(lines.join("\n")).toContain("saved-old");
    expect(lines.length).toBeLessThanOrEqual(historyPickerOverlayRows(10));
  });

  it("renders search and the no-results placeholder when two rows fit", () => {
    const { component, setTerminalRows } = makeComponent({
      initialQuery: "missing",
      initialSearch: searchSnapshot([]),
    });

    for (const terminalRows of [24, 18, 10, 6]) {
      setTerminalRows(terminalRows);
      const lines = component.render(80);
      expect(lines.length).toBeLessThanOrEqual(
        historyPickerOverlayRows(terminalRows),
      );
      expect(lines.some((line) => line.startsWith("Search: "))).toBe(true);
      expect(lines).toContain("No matching history");
    }

    setTerminalRows(5);
    const oneRow = component.render(80);
    expect(oneRow).toHaveLength(1);
    expect(oneRow[0]).toMatch(/^Search: /);
  });

  it("survives Pi's defensive prefix clip at every usable height", () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item(`clip-result-${index}`, 20 - index),
    );
    const selected = makeComponent({
      items,
      snapshot: {
        savedItems: [],
        loading: true,
        warning: "partial history",
      },
    });
    for (let index = 0; index < 12; index += 1) {
      selected.component.handleInput("DOWN");
    }
    const empty = makeComponent({
      initialQuery: "missing",
      initialSearch: searchSnapshot([]),
    });

    for (let terminalRows = 6; terminalRows <= 40; terminalRows += 1) {
      const budget = historyPickerOverlayRows(terminalRows);
      selected.setTerminalRows(terminalRows);
      const selectedClip = selected.component.render(80).slice(0, budget);
      expect(selectedClip.some((line) => line.startsWith("Search: "))).toBe(
        true,
      );
      expect(selectedClip.join("\n")).toContain("clip-result-12");

      empty.setTerminalRows(terminalRows);
      const emptyClip = empty.component.render(80).slice(0, budget);
      expect(emptyClip.some((line) => line.startsWith("Search: "))).toBe(true);
      expect(emptyClip).toContain("No matching history");
    }
  });
});
