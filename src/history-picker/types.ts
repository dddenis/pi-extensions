export interface HistoryItem {
  readonly text: string;
  readonly timestamp: number;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly source: "current" | "saved";
}

export type HistoryScope = "all" | "current-project";

export interface HistorySourceRange {
  readonly start: number;
  readonly end: number;
}

export interface HistoryMatchEvidence {
  readonly sourceRanges: ReadonlyArray<HistorySourceRange>;
  readonly focusRange: HistorySourceRange;
}

export type HistoryMatchTier =
  "exact" | "word-boundary" | "substring" | "fuzzy";

export interface HistorySearchResult {
  readonly item: HistoryItem;
  readonly matchTier?: HistoryMatchTier;
  readonly matchEvidence?: HistoryMatchEvidence;
}

export interface HistorySearchSnapshot {
  readonly results: ReadonlyArray<HistorySearchResult>;
  readonly hasMoreResults: boolean;
  readonly searching: boolean;
  readonly warning?: string;
}

export interface HistorySnapshot {
  readonly savedItems: ReadonlyArray<HistoryItem>;
  readonly loading: boolean;
  readonly warning?: string;
}
