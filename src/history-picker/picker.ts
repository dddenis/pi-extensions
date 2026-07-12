import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { projectHistoryPreview } from "./history-preview";
import type { HistorySearchRequest } from "./history-search-engine";
import { historyPickerBorderEnabled, historyPickerLayout } from "./layout";
import { HistoryPickerState } from "./picker-state";
import type {
  HistoryItem,
  HistoryScope,
  HistorySearchResult,
  HistorySearchSnapshot,
  HistorySnapshot,
} from "./types";

type PickerBinding =
  | "tui.select.cancel"
  | "tui.select.confirm"
  | "tui.select.up"
  | "tui.select.down";

export interface HistoryPickerKeybindings {
  readonly matches: (data: string, binding: PickerBinding) => boolean;
}

export interface HistoryPickerViewport {
  readonly requestRender: () => void;
  readonly terminalRows: () => number;
}

export interface HistoryPickerSearchPort {
  readonly replaceItems: (items: ReadonlyArray<HistoryItem>) => void;
  readonly search: (request: HistorySearchRequest) => void;
}

export interface HistoryPickerComponentOptions {
  readonly viewport: HistoryPickerViewport;
  readonly theme: Pick<Theme, "fg" | "bold">;
  readonly keybindings: HistoryPickerKeybindings;
  readonly searchPort: HistoryPickerSearchPort;
  readonly currentItems: ReadonlyArray<HistoryItem>;
  readonly snapshot: HistorySnapshot;
  readonly initialSearch: HistorySearchSnapshot;
  readonly initialQuery: string;
  readonly currentCwd: string;
  readonly onSelect: (text: string) => void;
  readonly onCancel: () => void;
}

export class HistoryPickerComponent implements Component, Focusable {
  private readonly viewport: HistoryPickerViewport;
  private readonly theme: Pick<Theme, "fg" | "bold">;
  private readonly keybindings: HistoryPickerKeybindings;
  private readonly searchPort: HistoryPickerSearchPort;
  private readonly currentItems: ReadonlyArray<HistoryItem>;
  private readonly currentCwd: string;
  private readonly input = new Input();
  private readonly state: HistoryPickerState;
  private readonly onSelect: (text: string) => void;
  private readonly onCancel: () => void;
  private snapshot: HistorySnapshot;
  private frameActiveForRender: boolean | undefined;
  private isFocused = false;

  constructor(options: HistoryPickerComponentOptions) {
    this.viewport = options.viewport;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.searchPort = options.searchPort;
    this.currentItems = [...options.currentItems];
    this.currentCwd = options.currentCwd;
    this.snapshot = options.snapshot;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.input.setValue(options.initialQuery);
    if (options.initialQuery.length > 0) {
      const seed = "\uE000".repeat(options.initialQuery.length);
      this.input.handleInput(`\x1b[200~${seed}\x1b[201~`);
      this.input.setValue(options.initialQuery);
    }
    this.state = new HistoryPickerState({
      initialQuery: options.initialQuery,
      initialSearch: options.initialSearch,
    });
    this.requestSearch();
    this.searchPort.replaceItems([
      ...this.currentItems,
      ...this.snapshot.savedItems,
    ]);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(focused: boolean) {
    this.isFocused = focused;
    this.input.focused = focused;
    this.viewport.requestRender();
  }

  get query(): string {
    return this.state.query;
  }

  get scope(): HistoryScope {
    return this.state.scope;
  }

  get results(): ReadonlyArray<HistorySearchResult> {
    return this.state.results;
  }

  get selectedIndex(): number {
    return this.state.selectedIndex;
  }

  setSearchSnapshot(snapshot: HistorySearchSnapshot): void {
    this.state.setSearchSnapshot(snapshot);
    this.viewport.requestRender();
  }

  setSavedSnapshot(snapshot: HistorySnapshot): void {
    this.snapshot = snapshot;
    this.searchPort.replaceItems([
      ...this.currentItems,
      ...snapshot.savedItems,
    ]);
    this.viewport.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.state.selectedResult;
      if (selected !== undefined) {
        this.onSelect(selected.item.text);
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.state.moveSelection(-1);
      this.viewport.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.state.moveSelection(1);
      this.viewport.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("p"))) {
      this.state.toggleScope();
      this.requestSearch();
      this.viewport.requestRender();
      return;
    }

    this.input.handleInput(data);
    this.state.setQuery(this.input.getValue());
    this.requestSearch();
    this.viewport.requestRender();
  }

  setFrameActiveForRender(frameActive: boolean): void {
    this.frameActiveForRender = frameActive;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const frameActiveForRender = this.frameActiveForRender;
    this.frameActiveForRender = undefined;
    if (safeWidth === 0) {
      return [];
    }

    const busy = [
      this.snapshot.loading ? "Loading saved sessions…" : undefined,
      this.state.searching ? "Searching…" : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" • ");
    const warnings = [this.snapshot.warning, this.state.warning]
      .filter((value): value is string => value !== undefined)
      .join(" • ");
    const terminalRows = this.viewport.terminalRows();
    const bordered =
      frameActiveForRender ??
      historyPickerBorderEnabled(terminalRows, safeWidth);
    const layout = historyPickerLayout({
      terminalRows,
      hasResults: this.state.results.length > 0,
      loading: busy.length > 0,
      warning: warnings.length > 0,
      bordered,
    });
    const lines: string[] = [];

    if (layout.sections.title) {
      lines.push(this.theme.fg("accent", this.theme.bold("History")));
    }

    const queryPrefix = "Search: ";
    const inputWidth = Math.max(1, safeWidth - queryPrefix.length);
    const inputLine = this.input.render(inputWidth)[0] ?? "";
    lines.push(`${queryPrefix}${inputLine}`);

    if (layout.sections.scope) {
      const scopeLabel =
        this.state.scope === "all" ? "all projects" : "current project";
      lines.push(
        this.theme.fg(
          "dim",
          `Scope: ${scopeLabel} (Ctrl+P to toggle) • Results: ${this.state.results.length}${this.state.hasMoreResults ? "+" : ""}`,
        ),
      );
    }

    const window = this.state.resultWindow(layout.resultRows);
    for (let index = window.start; index < window.end; index += 1) {
      const result = this.state.results[index];
      if (result === undefined) {
        continue;
      }
      const selected = index === this.state.selectedIndex;
      const prefix = selected ? "> " : "  ";
      const preview = projectHistoryPreview(
        result.item.text,
        result.matchEvidence,
        Math.max(0, safeWidth - visibleWidth(prefix)),
      );
      const text = `${prefix}${preview}`;
      lines.push(
        selected
          ? this.theme.fg("accent", this.theme.bold(text))
          : this.theme.fg("text", text),
      );
    }

    if (layout.showNoResults) {
      lines.push(this.theme.fg("muted", "No matching history"));
    }
    if (layout.sections.loading) {
      lines.push(this.theme.fg("dim", busy));
    }
    if (layout.sections.warning) {
      lines.push(this.theme.fg("warning", warnings));
    }
    if (layout.sections.help) {
      lines.push(
        this.theme.fg(
          "dim",
          "Navigate with configured up/down • confirm • cancel",
        ),
      );
    }

    return lines
      .slice(0, layout.contentRows)
      .map((line) => truncateToWidth(line, safeWidth));
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private requestSearch(): void {
    this.searchPort.search({
      query: this.state.query,
      scope: this.state.scope,
      currentCwd: this.currentCwd,
    });
  }
}
