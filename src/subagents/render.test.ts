import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { BatchProgress } from "./batch";
import {
  formatModelResult,
  renderSubagentCall,
  renderSubagentResult,
  type RenderTheme,
  type SubagentRenderDetails,
} from "./render";
import type { RunResult } from "./schemas";

const theme: RenderTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

const usage = {
  input: 10,
  output: 20,
  cacheRead: 3,
  cacheWrite: 4,
  cost: 0.25,
  turns: 2,
} as const;

const artifacts = (runId: string) => ({
  runId,
  runDirectory: `/runs/${runId}`,
  manifestPath: `/runs/${runId}/run.json`,
  taskPath: `/runs/${runId}/task.md`,
  systemPromptPath: `/runs/${runId}/system-prompt.md`,
  eventsPath: `/runs/${runId}/events.jsonl`,
  stderrPath: `/runs/${runId}/stderr.log`,
  statusPath: `/runs/${runId}/status.json`,
});

const result = (
  runId: string,
  agent: string,
  status: RunResult["status"],
  summary: string,
  options: { readonly reportPath?: string } = {},
): RunResult => ({
  runId,
  agent,
  status,
  summary,
  ...(options.reportPath === undefined
    ? {}
    : { reportPath: options.reportPath }),
  exitCode: status === "FAILED" ? 1 : 0,
  signal: null,
  usage,
  artifacts: artifacts(runId),
  diagnostics: status === "FAILED" ? ["provider unavailable"] : [],
});

const hasTerminalControls = (value: string): boolean =>
  Array.from(value.replace(/\n/gu, "")).some((codePoint) => {
    const code = codePoint.codePointAt(0);
    return (
      code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    );
  });

const assertNoTerminalControls = (value: string): void => {
  expect(hasTerminalControls(value)).toBe(false);
};

const assertBounded = (
  component: { readonly render: (width: number) => ReadonlyArray<string> },
  width: number,
): string => {
  const lines = component.render(width);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines)
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  return lines.join("\n");
};

const renderProgress = (
  progress: Omit<BatchProgress, "diagnostics"> & {
    readonly diagnostics?: ReadonlyArray<string>;
  },
  options: {
    readonly width?: number;
    readonly expanded?: boolean;
    readonly diagnostics?: ReadonlyArray<string>;
  } = {},
): string =>
  assertBounded(
    renderSubagentResult(
      {
        content: [
          {
            type: "text",
            text: '{"raw":"json and SECRET-TASK must stay hidden"}',
          },
        ],
        details: {
          phase: "progress",
          progress: {
            ...progress,
            diagnostics: progress.diagnostics ?? [],
          },
          diagnostics: options.diagnostics ?? [],
        } satisfies SubagentRenderDetails,
      },
      { expanded: options.expanded ?? false, isPartial: true },
      theme,
    ),
    options.width ?? 80,
  );

describe("subagent rendering", () => {
  it("renders omitted raw agent names as general", () => {
    const lines = renderSubagentCall(
      { tasks: [{ task: "Inspect" }] },
      theme,
    ).render(120);
    expect(lines.join("\n")).toContain("general");
  });

  it("formats final model results exactly in request order", () => {
    expect(
      formatModelResult([
        result("run-1", "alpha", "DONE", "Interfaces verified"),
        result("run-2", "beta", "BLOCKED", "Missing fixture", {
          reportPath: "/abs/report.md",
        }),
      ]),
    ).toBe(
      "run-1 alpha DONE: Interfaces verified\n" +
        "run-2 beta BLOCKED: Missing fixture (/abs/report.md)",
    );
  });

  it("strips CSI, BEL, C1, APC, and OSC-52 from rendered and model text", () => {
    const controls =
      "\u001b[31mCSI\u001b[0m BEL\u0007 C1\u0085 " +
      "\u001b_APC-PAYLOAD\u001b\\ " +
      "\u001b]52;c;T1NDLTUyLUNMSVBCT0FSRA==\u0007";
    const unsafe = result(
      `run-${controls}`,
      `agent-${controls}`,
      "FAILED",
      `summary-${controls}`,
      { reportPath: `/reports/${controls}.md` },
    );
    const poisoned: RunResult = {
      ...unsafe,
      diagnostics: [`diagnostic-${controls}`],
      artifacts: {
        runId: `${unsafe.artifacts.runId}-${controls}`,
        runDirectory: `${unsafe.artifacts.runDirectory}-${controls}`,
        manifestPath: `${unsafe.artifacts.manifestPath}-${controls}`,
        taskPath: `${unsafe.artifacts.taskPath}-${controls}`,
        systemPromptPath: `${unsafe.artifacts.systemPromptPath}-${controls}`,
        eventsPath: `${unsafe.artifacts.eventsPath}-${controls}`,
        stderrPath: `${unsafe.artifacts.stderrPath}-${controls}`,
        statusPath: `${unsafe.artifacts.statusPath}-${controls}`,
      },
    };
    const rendered = assertBounded(
      renderSubagentResult(
        {
          content: [],
          details: {
            phase: "complete",
            results: [poisoned],
            diagnostics: [`adapter-${controls}`],
          },
        },
        { expanded: true, isPartial: false },
        theme,
      ),
      200,
    );
    const progress = renderProgress(
      {
        children: [
          {
            runId: `progress-${controls}`,
            agent: `beta-${controls}`,
            lifecycle: "RUNNING",
            items: [
              { type: "assistant", text: controls },
              { type: "tool", name: controls, preview: controls },
            ],
            usage,
          },
        ],
      },
      { expanded: true, diagnostics: [controls], width: 200 },
    );
    const model = formatModelResult([poisoned]);
    const call = assertBounded(
      renderSubagentCall(
        { tasks: [{ agent: controls, task: "hidden", cwd: controls }] },
        theme,
      ),
      200,
    );

    for (const output of [rendered, progress, model, call]) {
      assertNoTerminalControls(output);
      expect(output).not.toContain("APC-PAYLOAD");
      expect(output).not.toContain("T1NDLTUyLUNMSVBCT0FSRA==");
    }
  });

  it("renders a bounded one-child partial view without raw transport", () => {
    const rendered = renderProgress({
      children: [
        {
          runId: "run-1",
          agent: "alpha",
          lifecycle: "RUNNING",
          items: [
            { type: "assistant", text: "Inspecting interfaces" },
            { type: "tool", name: "read", preview: "arguments hidden" },
          ],
          usage,
        },
      ],
    });

    expect(rendered).toContain("alpha");
    expect(rendered).toContain("Inspecting interfaces");
    expect(rendered).toContain("read");
    expect(rendered).not.toContain('"raw"');
  });

  it("shows invocation diagnostics in expanded partial views without raw or task leakage", () => {
    const rendered = renderProgress(
      {
        children: [
          {
            runId: "run-1",
            agent: "alpha",
            lifecycle: "RUNNING",
            items: [{ type: "assistant", text: "Inspecting interfaces" }],
            usage,
          },
        ],
      },
      {
        expanded: true,
        diagnostics: ["Pattern matched claude-sonnet-4-5"],
        width: 64,
      },
    );

    expect(rendered).toContain("invocation diagnostic:");
    expect(rendered).toContain("Pattern matched");
    expect(rendered).not.toContain('"raw"');
    expect(rendered).not.toContain("SECRET-TASK");
  });

  it("keeps invocation diagnostics hidden in collapsed partial views", () => {
    const rendered = renderProgress(
      {
        children: [
          {
            runId: "run-1",
            agent: "alpha",
            lifecycle: "RUNNING",
            items: [],
            usage,
          },
        ],
      },
      { diagnostics: ["Pattern matched claude-sonnet-4-5"] },
    );

    expect(rendered).not.toContain("invocation diagnostic");
    expect(rendered).not.toContain("Pattern matched");
    expect(rendered).not.toContain('"raw"');
    expect(rendered).not.toContain("SECRET-TASK");
  });

  it("renders all three bounded partial children", () => {
    const rendered = renderProgress({
      children: ["alpha", "beta", "gamma"].map((agent, index) => ({
        runId: `run-${index + 1}`,
        agent,
        lifecycle: index === 0 ? "RUNNING" : "STARTING",
        items: [],
        usage,
      })),
    });

    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("gamma");
  });

  it("renders mixed final statuses and hides details while collapsed", () => {
    const details: SubagentRenderDetails = {
      phase: "complete",
      results: [
        result("run-1", "alpha", "DONE", "Verified"),
        result("run-2", "beta", "BLOCKED", "Missing fixture"),
        result("run-3", "gamma", "FAILED", "Provider failed"),
      ],
      diagnostics: ["model alias warning"],
    };
    const rendered = assertBounded(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "raw task body SECRET-TASK" }],
          details,
        },
        { expanded: false, isPartial: false },
        theme,
      ),
      80,
    );

    expect(rendered).toContain("DONE");
    expect(rendered).toContain("BLOCKED");
    expect(rendered).toContain("FAILED");
    expect(rendered).not.toContain("SECRET-TASK");
    expect(rendered).not.toContain("/runs/run-1");
    expect(rendered).not.toContain("model alias warning");
  });

  it("shows artifacts, process state, usage, and diagnostics only when expanded", () => {
    const rendered = assertBounded(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: {
            phase: "complete",
            results: [result("run-3", "gamma", "FAILED", "Provider failed")],
            diagnostics: ["model alias warning"],
          } satisfies SubagentRenderDetails,
        },
        { expanded: true, isPartial: false },
        theme,
      ),
      100,
    );

    expect(rendered).toContain("/runs/run-3");
    expect(rendered).toContain("exit: 1");
    expect(rendered).toContain("signal: none");
    expect(rendered).toContain("input=10");
    expect(rendered).toContain("diagnostic: provider unavailable");
    expect(rendered).toContain("invocation diagnostic: model alias warning");
  });

  it("keeps call and result lines bounded at narrow widths without task bodies", () => {
    const secret = "SECRET-TASK-BODY-THAT-MUST-NEVER-RENDER";
    const call = assertBounded(
      renderSubagentCall(
        {
          tasks: [
            {
              agent: "alpha-with-a-very-long-name",
              task: secret,
              cwd: "/a/very/long/working/directory",
            },
          ],
        },
        theme,
      ),
      12,
    );
    const partial = renderProgress(
      {
        children: [
          {
            runId: "run-with-a-long-id",
            agent: "alpha-with-a-very-long-name",
            lifecycle: "RUNNING",
            items: [
              {
                type: "assistant",
                text: "A very long assistant preview that must be clipped safely",
              },
            ],
            usage,
          },
        ],
      },
      { width: 12 },
    );

    expect(call).not.toContain(secret);
    expect(partial).not.toContain('{"raw"');
  });

  it("selects semantic status colors and remains stable after invalidation", () => {
    const colorCalls: Array<{ readonly color: string; readonly text: string }> =
      [];
    const recordingTheme: RenderTheme = {
      bold: (text) => text,
      fg: (color, text) => {
        colorCalls.push({ color, text });
        return text;
      },
    };
    const component = renderSubagentResult(
      {
        content: [{ type: "text", text: "raw SECRET-TASK" }],
        details: {
          phase: "complete",
          results: [
            result("run-1", "alpha", "DONE", "Verified"),
            result(
              "run-2",
              "alpha",
              "DONE_WITH_CONCERNS",
              "Verified with concerns",
            ),
            result("run-3", "beta", "NEEDS_CONTEXT", "Need fixture"),
            result("run-4", "beta", "BLOCKED", "Missing fixture"),
            result("run-5", "gamma", "FAILED", "Provider failed"),
            result("run-6", "gamma", "ABORTED", "Parent cancelled"),
          ],
          diagnostics: [],
        },
      },
      { expanded: false, isPartial: false },
      recordingTheme,
    );

    const before = assertBounded(component, 28);
    component.invalidate();
    const after = assertBounded(component, 12);

    expect(colorCalls).toContainEqual({ color: "success", text: "DONE" });
    for (const status of ["DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"]) {
      expect(colorCalls).toContainEqual({ color: "warning", text: status });
    }
    for (const status of ["FAILED", "ABORTED"]) {
      expect(colorCalls).toContainEqual({ color: "error", text: status });
    }
    expect(before).not.toContain("SECRET-TASK");
    expect(after).not.toContain("SECRET-TASK");
  });
});
