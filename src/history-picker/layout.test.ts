import { describe, expect, it } from "vitest";
import {
  HISTORY_PICKER_LAYOUT_POLICY,
  historyPickerBorderEnabled,
  historyPickerLayout,
  historyPickerOverlayRows,
} from "./layout";

const referenceOverlayRows = (terminalRows: number): number => {
  const normalized =
    Number.isFinite(terminalRows) && terminalRows > 0
      ? Math.floor(terminalRows)
      : 0;
  const percent = Number.parseFloat(HISTORY_PICKER_LAYOUT_POLICY.maximumHeight);
  const percentageLimit = Math.floor((normalized * percent) / 100);
  const marginLimit = Math.max(
    1,
    normalized - HISTORY_PICKER_LAYOUT_POLICY.marginRows * 2,
  );
  return Math.max(1, Math.min(percentageLimit, marginLimit));
};

const optionalCount = (
  layout: ReturnType<typeof historyPickerLayout>,
): number =>
  [
    layout.sections.title,
    layout.sections.scope,
    layout.sections.loading,
    layout.sections.warning,
    layout.sections.help,
  ].filter(Boolean).length;

const layoutFor = (input: {
  readonly terminalRows: number;
  readonly hasResults: boolean;
  readonly loading: boolean;
  readonly warning: boolean;
  readonly renderWidth?: number;
}) =>
  historyPickerLayout({
    terminalRows: input.terminalRows,
    hasResults: input.hasResults,
    loading: input.loading,
    warning: input.warning,
    bordered: historyPickerBorderEnabled(
      input.terminalRows,
      input.renderWidth ?? 80,
    ),
  });

describe("history picker responsive layout", () => {
  it("matches Pi percentage rounding and margin clamping for rows 1 through 40", () => {
    for (let terminalRows = 1; terminalRows <= 40; terminalRows += 1) {
      expect(historyPickerOverlayRows(terminalRows)).toBe(
        referenceOverlayRows(terminalRows),
      );
    }
  });

  it("normalizes invalid and fractional terminal row counts", () => {
    expect(historyPickerOverlayRows(Number.NaN)).toBe(1);
    expect(historyPickerOverlayRows(Number.POSITIVE_INFINITY)).toBe(1);
    expect(historyPickerOverlayRows(-10)).toBe(1);
    expect(historyPickerOverlayRows(6.9)).toBe(2);
  });

  it.each([
    {
      terminalRows: 5,
      overlayRows: 1,
      contentRows: 1,
      bordered: false,
      resultRows: 0,
    },
    {
      terminalRows: 6,
      overlayRows: 2,
      contentRows: 2,
      bordered: false,
      resultRows: 1,
    },
    {
      terminalRows: 7,
      overlayRows: 3,
      contentRows: 3,
      bordered: false,
      resultRows: 1,
    },
    {
      terminalRows: 8,
      overlayRows: 4,
      contentRows: 2,
      bordered: true,
      resultRows: 1,
    },
    {
      terminalRows: 18,
      overlayRows: 14,
      contentRows: 12,
      bordered: true,
      resultRows: 8,
    },
    {
      terminalRows: 20,
      overlayRows: 16,
      contentRows: 14,
      bordered: true,
      resultRows: 10,
    },
    {
      terminalRows: 23,
      overlayRows: 18,
      contentRows: 16,
      bordered: true,
      resultRows: 12,
    },
  ])(
    "budgets a responsive frame at $terminalRows terminal rows",
    ({ terminalRows, overlayRows, contentRows, bordered, resultRows }) => {
      const layout = layoutFor({
        terminalRows,
        hasResults: true,
        loading: false,
        warning: false,
      });
      expect(layout).toMatchObject({
        overlayRows,
        contentRows,
        bordered,
        resultRows,
      });
    },
  );

  it("uses the full overlay row budget below the padded frame width", () => {
    expect(historyPickerBorderEnabled(24, 4)).toBe(false);
    expect(historyPickerBorderEnabled(24, 5)).toBe(true);
    const layout = layoutFor({
      terminalRows: 24,
      hasResults: true,
      loading: true,
      warning: true,
      renderWidth: 4,
    });

    expect(layout).toMatchObject({
      overlayRows: 19,
      contentRows: 19,
      bordered: false,
      resultRows: 12,
    });
  });

  it.each([
    { terminalRows: 11, visible: ["title", "scope", "warning"] },
    { terminalRows: 10, visible: ["title", "warning"] },
    { terminalRows: 9, visible: ["warning"] },
    { terminalRows: 8, visible: [] },
    { terminalRows: 7, visible: ["warning"] },
    { terminalRows: 6, visible: [] },
  ])(
    "removes optional sections in priority order at $terminalRows rows",
    ({ terminalRows, visible }) => {
      const layout = layoutFor({
        terminalRows,
        hasResults: true,
        loading: true,
        warning: true,
      });
      const shown = (
        ["title", "scope", "loading", "warning", "help"] as const
      ).filter((section) => layout.sections[section]);
      expect(shown).toEqual(visible);
      expect(layout.resultRows).toBeGreaterThanOrEqual(1);
    },
  );

  it("retains every applicable row and 12 results on a normal terminal", () => {
    const layout = layoutFor({
      terminalRows: 24,
      hasResults: true,
      loading: true,
      warning: true,
    });
    expect(layout).toEqual({
      overlayRows: 19,
      contentRows: 17,
      bordered: true,
      sections: {
        title: true,
        search: true,
        scope: true,
        loading: true,
        warning: true,
        help: true,
      },
      resultRows: 11,
      showNoResults: false,
    });
  });

  it("reserves search and a placeholder whenever at least two rows fit", () => {
    for (let terminalRows = 1; terminalRows <= 40; terminalRows += 1) {
      const layout = layoutFor({
        terminalRows,
        hasResults: false,
        loading: true,
        warning: true,
      });
      expect(layout.sections.search).toBe(true);
      expect(layout.showNoResults).toBe(layout.overlayRows >= 2);
    }
  });

  it("keeps every layout within budget for all status combinations", () => {
    for (let terminalRows = 1; terminalRows <= 40; terminalRows += 1) {
      for (const loading of [false, true]) {
        for (const warning of [false, true]) {
          const layout = layoutFor({
            terminalRows,
            hasResults: true,
            loading,
            warning,
          });
          const renderedRows =
            1 +
            optionalCount(layout) +
            layout.resultRows +
            (layout.bordered ? 2 : 0);
          expect(layout.overlayRows).toBeGreaterThanOrEqual(1);
          expect(layout.resultRows).toBeGreaterThanOrEqual(0);
          expect(layout.resultRows).toBeLessThanOrEqual(12);
          expect(renderedRows).toBeLessThanOrEqual(layout.overlayRows);
          if (layout.overlayRows >= 2) {
            expect(layout.resultRows).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
  });
});
