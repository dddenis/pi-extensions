import type {
  HistoryScope,
  HistorySearchResult,
  HistorySearchSnapshot,
} from "./types";

export interface ResultWindow {
  readonly start: number;
  readonly end: number;
}

export const resultWindow = (
  resultCount: number,
  selectedIndex: number,
  maximumRows: number,
): ResultWindow => {
  const count = Math.max(0, Math.floor(resultCount));
  const rows = Math.max(0, Math.floor(maximumRows));
  if (count === 0 || rows === 0) {
    return { start: 0, end: 0 };
  }

  const selected = Math.min(count - 1, Math.max(0, Math.floor(selectedIndex)));
  const end = Math.min(count, Math.max(rows, selected + 1));
  return { start: Math.max(0, end - rows), end };
};

export interface HistoryPickerStateOptions {
  readonly initialQuery: string;
  readonly initialSearch: HistorySearchSnapshot;
}

const copyHistorySearchSnapshot = (
  snapshot: HistorySearchSnapshot,
): HistorySearchSnapshot => ({
  results: snapshot.results.map((result) => ({
    item: { ...result.item },
    ...(result.matchTier === undefined ? {} : { matchTier: result.matchTier }),
    ...(result.matchEvidence === undefined
      ? {}
      : {
          matchEvidence: {
            sourceRanges: result.matchEvidence.sourceRanges.map((range) => ({
              ...range,
            })),
            focusRange: { ...result.matchEvidence.focusRange },
          },
        }),
  })),
  hasMoreResults: snapshot.hasMoreResults,
  searching: snapshot.searching,
  ...(snapshot.warning === undefined ? {} : { warning: snapshot.warning }),
});

export class HistoryPickerState {
  private currentQuery: string;
  private currentScope: HistoryScope = "all";
  private currentSearch: HistorySearchSnapshot;
  private currentSelectedIndex = 0;

  constructor(options: HistoryPickerStateOptions) {
    this.currentQuery = options.initialQuery;
    this.currentSearch = copyHistorySearchSnapshot(options.initialSearch);
  }

  get query(): string {
    return this.currentQuery;
  }

  get scope(): HistoryScope {
    return this.currentScope;
  }

  get results(): ReadonlyArray<HistorySearchResult> {
    return this.currentSearch.results;
  }

  get hasMoreResults(): boolean {
    return this.currentSearch.hasMoreResults;
  }

  get searching(): boolean {
    return this.currentSearch.searching;
  }

  get warning(): string | undefined {
    return this.currentSearch.warning;
  }

  get selectedIndex(): number {
    return this.currentSelectedIndex;
  }

  get selectedResult(): HistorySearchResult | undefined {
    return this.currentSearch.results[this.currentSelectedIndex];
  }

  setQuery(query: string): void {
    this.currentQuery = query;
  }

  toggleScope(): void {
    this.currentScope = this.currentScope === "all" ? "current-project" : "all";
    this.currentSelectedIndex = 0;
  }

  setSearchSnapshot(snapshot: HistorySearchSnapshot): void {
    this.currentSearch = copyHistorySearchSnapshot(snapshot);
    this.currentSelectedIndex = Math.min(
      this.currentSelectedIndex,
      Math.max(0, this.currentSearch.results.length - 1),
    );
  }

  moveSelection(delta: number): void {
    if (this.currentSearch.results.length === 0) {
      this.currentSelectedIndex = 0;
      return;
    }
    this.currentSelectedIndex = Math.min(
      this.currentSearch.results.length - 1,
      Math.max(0, this.currentSelectedIndex + Math.trunc(delta)),
    );
  }

  resultWindow(maximumRows: number): ResultWindow {
    return resultWindow(
      this.currentSearch.results.length,
      this.currentSelectedIndex,
      maximumRows,
    );
  }
}
