import {
  FULL_BOX_MINIMUM_FRAME_WIDTH,
  fullBoxFrameWidthEnabled,
} from "../lib/full-box";

export const HISTORY_PICKER_LAYOUT_POLICY = {
  maximumHeight: "80%",
  marginRows: 2,
  maximumResultRows: 12,
  minimumBorderedRows: 4,
  minimumBorderedColumns: FULL_BOX_MINIMUM_FRAME_WIDTH,
} as const;

export interface HistoryPickerLayoutInput {
  readonly terminalRows: number;
  readonly hasResults: boolean;
  readonly loading: boolean;
  readonly warning: boolean;
  readonly bordered: boolean;
}

export interface HistoryPickerLayoutSections {
  readonly title: boolean;
  readonly search: true;
  readonly scope: boolean;
  readonly loading: boolean;
  readonly warning: boolean;
  readonly help: boolean;
}

export interface HistoryPickerLayout {
  readonly overlayRows: number;
  readonly contentRows: number;
  readonly bordered: boolean;
  readonly sections: HistoryPickerLayoutSections;
  readonly resultRows: number;
  readonly showNoResults: boolean;
}

type OptionalSection = Exclude<keyof HistoryPickerLayoutSections, "search">;

const OPTIONAL_SECTION_REMOVAL_ORDER: ReadonlyArray<OptionalSection> = [
  "help",
  "loading",
  "scope",
  "title",
  "warning",
];

const normalizedTerminalRows = (terminalRows: number): number =>
  Number.isFinite(terminalRows) && terminalRows > 0
    ? Math.floor(terminalRows)
    : 0;

export const historyPickerOverlayRows = (terminalRows: number): number => {
  const rows = normalizedTerminalRows(terminalRows);
  const percentage = Number.parseFloat(
    HISTORY_PICKER_LAYOUT_POLICY.maximumHeight,
  );
  const percentageLimit = Math.floor((rows * percentage) / 100);
  const marginLimit = Math.max(
    1,
    rows - HISTORY_PICKER_LAYOUT_POLICY.marginRows * 2,
  );
  return Math.max(1, Math.min(percentageLimit, marginLimit));
};

export const historyPickerBorderEnabled = (
  terminalRows: number,
  renderWidth: number,
): boolean =>
  historyPickerOverlayRows(terminalRows) >=
    HISTORY_PICKER_LAYOUT_POLICY.minimumBorderedRows &&
  fullBoxFrameWidthEnabled(renderWidth);

export const historyPickerLayout = (
  input: HistoryPickerLayoutInput,
): HistoryPickerLayout => {
  const overlayRows = historyPickerOverlayRows(input.terminalRows);
  const bordered = input.bordered;
  const contentRows = Math.max(1, overlayRows - (bordered ? 2 : 0));
  const visible: Record<OptionalSection, boolean> = {
    title: true,
    scope: true,
    loading: input.loading,
    warning: input.warning,
    help: true,
  };
  const countOptionalRows = (): number =>
    Object.values(visible).filter(Boolean).length;

  for (const section of OPTIONAL_SECTION_REMOVAL_ORDER) {
    if (contentRows >= 2 && 2 + countOptionalRows() <= contentRows) {
      break;
    }
    visible[section] = false;
  }

  const resultRows =
    contentRows >= 2
      ? Math.min(
          HISTORY_PICKER_LAYOUT_POLICY.maximumResultRows,
          contentRows - 1 - countOptionalRows(),
        )
      : 0;

  return {
    overlayRows,
    contentRows,
    bordered,
    sections: {
      title: visible.title,
      search: true,
      scope: visible.scope,
      loading: visible.loading,
      warning: visible.warning,
      help: visible.help,
    },
    resultRows,
    showNoResults: !input.hasResults && resultRows > 0,
  };
};
