import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  buildFooterRenderData,
  formatFooterTokens,
  renderFooter,
  type FooterPalette,
  type FooterRenderInput,
} from "./footer";

const palette: FooterPalette = {
  dim: (text) => `\u001b[2m${text}\u001b[22m`,
  warning: (text) => `\u001b[33m${text}\u001b[39m`,
  error: (text) => `\u001b[31m${text}\u001b[39m`,
};

const plainPalette: FooterPalette = {
  dim: (text) => text,
  warning: (text) => text,
  error: (text) => text,
};

interface UsageValues {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalCost: number;
}

const usage = (values: Partial<UsageValues> = {}) => ({
  input: values.input ?? 0,
  output: values.output ?? 0,
  cacheRead: values.cacheRead ?? 0,
  cacheWrite: values.cacheWrite ?? 0,
  cost: { total: values.totalCost ?? 0 },
});

const input = (
  overrides: Partial<FooterRenderInput> = {},
): FooterRenderInput => ({
  cwd: "/home/me/work",
  homeDirectory: "/home/me",
  entries: [],
  contextUsage: { tokens: 36_400, contextWindow: 200_000, percent: 18.2 },
  model: {
    id: "gpt-5.4",
    provider: "openai-codex",
    reasoning: true,
    contextWindow: 200_000,
  },
  thinkingLevel: "high",
  availableProviderCount: 1,
  extensionStatuses: new Map(),
  usingSubscription: false,
  autoCompactEnabled: true,
  ...overrides,
});

const messageEntry = (
  values: Parameters<typeof usage>[0],
): FooterRenderInput["entries"][number] => ({
  type: "message",
  message: { role: "assistant", usage: usage(values) },
});

describe("custom footer extraction", () => {
  it("contracts only home itself and descendants", () => {
    expect(buildFooterRenderData(input({ cwd: "/home/me" })).location).toBe(
      "~",
    );
    expect(
      buildFooterRenderData(input({ cwd: "/home/me/project" })).location,
    ).toBe("~/project");
    expect(
      buildFooterRenderData(input({ cwd: "/home/meanwhile/project" })).location,
    ).toBe("/home/meanwhile/project");
  });

  it("adds optional branch and session text to the location line", () => {
    expect(
      buildFooterRenderData(
        input({ branch: "main", sessionName: "footer task" }),
      ).location,
    ).toBe("~/work (main) • footer task");
  });

  it("totals every assistant entry and uses the latest cache-hit percentage", () => {
    const data = buildFooterRenderData(
      input({
        entries: [
          messageEntry({
            input: 900,
            output: 20_000,
            cacheRead: 300,
            cacheWrite: 100,
            totalCost: 0.1,
          }),
          { type: "custom" },
          messageEntry({
            input: 1_100,
            output: 900_000,
            cacheRead: 600,
            cacheWrite: 300,
            totalCost: 0.0234,
          }),
        ],
        usingSubscription: true,
      }),
    );

    expect(data.stats).toEqual([
      { text: "↑2.0k", tone: "dim" },
      { text: "↓920k", tone: "dim" },
      { text: "R900", tone: "dim" },
      { text: "W400", tone: "dim" },
      { text: "CH30.0%", tone: "dim" },
      { text: "$0.123 (sub)", tone: "dim" },
      { text: "81.8% (200k auto)", tone: "dim" },
    ]);
  });

  it("totals every persisted usage source using the assistant cache-hit percentage", () => {
    const entries = [
      messageEntry({
        input: 100,
        output: 10,
        cacheRead: 50,
        totalCost: 0.1,
      }),
      {
        type: "message",
        message: {
          role: "toolResult",
          usage: usage({
            input: 200,
            output: 20,
            cacheRead: 60,
            cacheWrite: 10,
            totalCost: 0.2,
          }),
        },
      },
      {
        type: "compaction",
        usage: usage({
          input: 300,
          output: 30,
          cacheRead: 70,
          cacheWrite: 20,
          totalCost: 0.3,
        }),
      },
      {
        type: "branch_summary",
        usage: usage({
          input: 400,
          output: 40,
          cacheRead: 80,
          cacheWrite: 30,
          totalCost: 0.4,
        }),
      },
    ];

    expect(buildFooterRenderData(input({ entries })).stats).toEqual([
      { text: "↑1.0k", tone: "dim" },
      { text: "↓100", tone: "dim" },
      { text: "R260", tone: "dim" },
      { text: "W60", tone: "dim" },
      { text: "CH33.3%", tone: "dim" },
      { text: "$1.000", tone: "dim" },
      { text: "81.8% (200k auto)", tone: "dim" },
    ]);
  });

  it("formats token boundaries exactly", () => {
    expect(
      [
        999, 1_000, 9_999, 10_000, 999_999, 1_000_000, 9_999_999, 10_000_000,
      ].map(formatFooterTokens),
    ).toEqual(["999", "1.0k", "10.0k", "10k", "1000k", "1.0M", "10.0M", "10M"]);
  });

  it("renders unknown, normal, warning, and error remaining context at boundaries", () => {
    const context = (percent: number | null) =>
      buildFooterRenderData(
        input({
          contextUsage: { tokens: null, contextWindow: 200_000, percent },
        }),
      ).stats.at(-1);

    expect(context(null)).toEqual({ text: "? (200k auto)", tone: "dim" });
    expect(context(69.9)).toEqual({ text: "30.1% (200k auto)", tone: "dim" });
    expect(context(70)).toEqual({ text: "30.0% (200k auto)", tone: "warning" });
    expect(context(90)).toEqual({ text: "10.0% (200k auto)", tone: "error" });
    expect(context(95)).toEqual({ text: "5.0% (200k auto)", tone: "error" });
    expect(
      buildFooterRenderData(
        input({
          autoCompactEnabled: false,
          contextUsage: {
            tokens: 190_000,
            contextWindow: 200_000,
            percent: 95,
          },
        }),
      ).stats.at(-1),
    ).toEqual({ text: "5.0% (200k)", tone: "error" });
    expect(context(100)).toEqual({ text: "0.0% (200k auto)", tone: "error" });
  });

  it("shows provider only for multiple providers when it fits and copies thinking state", () => {
    const data = buildFooterRenderData(
      input({ availableProviderCount: 2, thinkingLevel: "off" }),
    );
    expect(renderFooter(data, 93, plainPalette)[1]).toContain(
      "(openai-codex) gpt-5.4 • thinking off",
    );
    expect(renderFooter(data, 36, plainPalette)[1]).not.toContain(
      "(openai-codex)",
    );
  });

  it("strips the OpenAI prefix from inline rate status and emits no pending placeholder", () => {
    expect(
      buildFooterRenderData(
        input({ rateLimitStatus: " OpenAI limits  5h 90%\t| wk 80% " }),
      ).stats.at(-1),
    ).toEqual({ text: "5h 90% | wk 80%", tone: "dim" });
    const pending = renderFooter(
      buildFooterRenderData(input()),
      160,
      plainPalette,
    ).join("\n");
    expect(pending).not.toMatch(/loading|unavailable/i);
  });

  it("sorts statuses by key, sanitizes whitespace, and omits empty values", () => {
    const lines = renderFooter(
      buildFooterRenderData(
        input({
          extensionStatuses: new Map([
            ["z", "  zed\r\n status "],
            ["a", " alpha\t status "],
            ["empty", " \n\t "],
          ]),
        }),
      ),
      160,
      plainPalette,
    );
    expect(lines[2]).toBe("alpha status zed status");
  });
});

describe("custom footer terminal rendering", () => {
  it("never exceeds terminal cells for zero, narrow, CJK, emoji, and combining input", () => {
    const renderData = buildFooterRenderData(
      input({
        cwd: "/home/me/项目/👩🏽‍💻/e\u0301",
        branch: "功能/🚀",
        sessionName: "组合e\u0301",
        rateLimitStatus: "OpenAI 5h ９９% 🚀 | wk 80%",
        model: {
          id: "模型-👩🏽‍💻-e\u0301",
          provider: "供应商",
          reasoning: true,
          contextWindow: 200_000,
        },
        availableProviderCount: 2,
        extensionStatuses: new Map([["状态", "完成 ✅ 组合e\u0301"]]),
      }),
    );

    for (const width of [0, 1, 12, 60, 93, 160]) {
      for (const line of renderFooter(renderData, width, palette)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it.each([
    { usedPercent: 70, color: "\u001b[33m", label: "warning" },
    { usedPercent: 90, color: "\u001b[31m", label: "error" },
  ])(
    "confines $label styling when terminal pressure truncates the context segment",
    ({ usedPercent, color }) => {
      const width = 12;
      const data = buildFooterRenderData(
        input({
          entries: [],
          contextUsage: {
            tokens: 140_000,
            contextWindow: 200_000,
            percent: usedPercent,
          },
          model: undefined,
          rateLimitStatus: undefined,
        }),
      );
      const context = data.stats[0];
      expect(context).toBeDefined();
      if (context === undefined) return;
      expect(visibleWidth(context.text)).toBeGreaterThan(width);

      const line = renderFooter(data, width, palette)[1] ?? "";
      const contextStyleStart = line.indexOf(color);
      const truncatedContextEnd = line.indexOf("\u001b[0m", contextStyleStart);
      const adjacentDimStart = line.indexOf("\u001b[2m", truncatedContextEnd);

      expect(contextStyleStart).toBe(0);
      expect(truncatedContextEnd).toBeGreaterThan(contextStyleStart);
      expect(adjacentDimStart).toBeGreaterThan(truncatedContextEnd);
      expect(line.slice(adjacentDimStart)).toContain("...");
      expect(line.slice(adjacentDimStart)).not.toContain(color);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    },
  );
});
