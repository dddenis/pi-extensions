import type { Component } from "@earendil-works/pi-tui";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { BatchProgress } from "./batch";
import type { RunResult, TerminalStatus } from "./schemas";
import { sanitizeTerminalText } from "./terminal-text";

export interface RenderTheme {
  readonly bold: (text: string) => string;
  readonly fg: (
    color:
      | "accent"
      | "dim"
      | "error"
      | "muted"
      | "success"
      | "toolTitle"
      | "warning",
    text: string,
  ) => string;
}

export interface SubagentCallArguments {
  readonly tasks: ReadonlyArray<{
    readonly agent: string;
    readonly task: string;
    readonly cwd?: string;
  }>;
}

export type SubagentRenderDetails =
  | {
      readonly phase: "progress";
      readonly progress: BatchProgress;
      readonly diagnostics: ReadonlyArray<string>;
    }
  | {
      readonly phase: "complete";
      readonly results: ReadonlyArray<RunResult>;
      readonly diagnostics: ReadonlyArray<string>;
    };

export interface SubagentRenderResult {
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
  readonly details?: SubagentRenderDetails;
}

export interface SubagentRenderOptions {
  readonly expanded: boolean;
  readonly isPartial: boolean;
}

class BoundedContainer extends Container {
  constructor(private readonly lines: ReadonlyArray<string>) {
    super();
  }

  override render(width: number): string[] {
    const boundedWidth = Math.max(0, width);
    this.clear();
    for (const line of this.lines) {
      this.addChild(new Text(truncateToWidth(line, boundedWidth, ""), 0, 0));
    }
    return super
      .render(boundedWidth)
      .map((line) => truncateToWidth(line, boundedWidth, ""));
  }
}

const componentFromLines = (lines: ReadonlyArray<string>): Component =>
  new BoundedContainer(lines);

const statusColor = (
  status: TerminalStatus,
): Parameters<RenderTheme["fg"]>[0] => {
  switch (status) {
    case "DONE":
      return "success";
    case "DONE_WITH_CONCERNS":
    case "NEEDS_CONTEXT":
    case "BLOCKED":
      return "warning";
    case "FAILED":
    case "ABORTED":
      return "error";
  }
};

const lifecycleColor = (
  lifecycle: BatchProgress["children"][number]["lifecycle"],
): Parameters<RenderTheme["fg"]>[0] => {
  switch (lifecycle) {
    case "STARTING":
      return "dim";
    case "RUNNING":
      return "accent";
    case "SETTLED":
      return "muted";
  }
};

const progressLines = (
  progress: BatchProgress,
  expanded: boolean,
  adapterDiagnostics: ReadonlyArray<string>,
  theme: RenderTheme,
): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  for (const child of progress.children) {
    lines.push(
      `${theme.fg("muted", sanitizeTerminalText(child.runId))} ${theme.fg("toolTitle", theme.bold(sanitizeTerminalText(child.agent)))} ${theme.fg(lifecycleColor(child.lifecycle), child.lifecycle)}`,
    );
    for (const item of child.items) {
      lines.push(
        item.type === "assistant"
          ? `  ${theme.fg("muted", "assistant")} ${theme.fg("dim", sanitizeTerminalText(item.text))}`
          : `  ${theme.fg("muted", "tool")} ${theme.fg("accent", sanitizeTerminalText(item.name))} ${theme.fg("dim", sanitizeTerminalText(item.preview))}`,
      );
    }
    if (expanded) {
      lines.push(
        theme.fg(
          "dim",
          `  usage: input=${child.usage.input} output=${child.usage.output} cacheRead=${child.usage.cacheRead} cacheWrite=${child.usage.cacheWrite} cost=${child.usage.cost} turns=${child.usage.turns}`,
        ),
      );
    }
  }
  if (expanded) {
    for (const diagnostic of adapterDiagnostics) {
      lines.push(
        theme.fg(
          "warning",
          `invocation diagnostic: ${sanitizeTerminalText(diagnostic)}`,
        ),
      );
    }
  }
  return lines.length === 0
    ? [theme.fg("dim", "Waiting for subagent progress")]
    : lines;
};

const resultLines = (
  results: ReadonlyArray<RunResult>,
  expanded: boolean,
  adapterDiagnostics: ReadonlyArray<string>,
  theme: RenderTheme,
): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  for (const result of results) {
    lines.push(
      `${theme.fg("muted", sanitizeTerminalText(result.runId))} ${theme.fg("toolTitle", theme.bold(sanitizeTerminalText(result.agent)))} ${theme.fg(statusColor(result.status), result.status)}: ${theme.fg("muted", sanitizeTerminalText(result.summary))}`,
    );
    if (!expanded) continue;
    if (result.reportPath !== undefined) {
      lines.push(
        theme.fg("dim", `  report: ${sanitizeTerminalText(result.reportPath)}`),
      );
    }
    lines.push(
      theme.fg(
        "dim",
        `  run: ${sanitizeTerminalText(result.artifacts.runDirectory)}`,
      ),
    );
    lines.push(
      theme.fg(
        "dim",
        `  manifest: ${sanitizeTerminalText(result.artifacts.manifestPath)}`,
      ),
    );
    lines.push(
      theme.fg(
        "dim",
        `  task: ${sanitizeTerminalText(result.artifacts.taskPath)}`,
      ),
    );
    lines.push(
      theme.fg(
        "dim",
        `  system prompt: ${sanitizeTerminalText(result.artifacts.systemPromptPath)}`,
      ),
    );
    lines.push(
      theme.fg(
        "dim",
        `  events: ${sanitizeTerminalText(result.artifacts.eventsPath)}`,
      ),
    );
    lines.push(
      theme.fg(
        "dim",
        `  stderr: ${sanitizeTerminalText(result.artifacts.stderrPath)}`,
      ),
    );
    lines.push(
      theme.fg(
        "dim",
        `  status: ${sanitizeTerminalText(result.artifacts.statusPath)}`,
      ),
    );
    lines.push(
      theme.fg(
        "dim",
        `  exit: ${result.exitCode ?? "none"} signal: ${result.signal ?? "none"}`,
      ),
    );
    lines.push(
      theme.fg(
        "dim",
        `  usage: input=${result.usage.input} output=${result.usage.output} cacheRead=${result.usage.cacheRead} cacheWrite=${result.usage.cacheWrite} cost=${result.usage.cost} turns=${result.usage.turns}`,
      ),
    );
    for (const diagnostic of result.diagnostics) {
      lines.push(
        theme.fg(
          "warning",
          `  diagnostic: ${sanitizeTerminalText(diagnostic)}`,
        ),
      );
    }
  }
  if (expanded) {
    for (const diagnostic of adapterDiagnostics) {
      lines.push(
        theme.fg(
          "warning",
          `invocation diagnostic: ${sanitizeTerminalText(diagnostic)}`,
        ),
      );
    }
  }
  return lines.length === 0 ? [theme.fg("dim", "No subagent results")] : lines;
};

export const formatModelResult = (results: ReadonlyArray<RunResult>): string =>
  results
    .map(
      (result) =>
        `${sanitizeTerminalText(result.runId)} ${sanitizeTerminalText(result.agent)} ${result.status}: ${sanitizeTerminalText(result.summary)}${result.reportPath === undefined ? "" : ` (${sanitizeTerminalText(result.reportPath)})`}`,
    )
    .join("\n");

export const renderSubagentCall = (
  args: SubagentCallArguments,
  theme: RenderTheme,
): Component => {
  const count = args.tasks.length;
  const agents = args.tasks
    .map(({ agent }) => sanitizeTerminalText(agent))
    .join(", ");
  return componentFromLines([
    `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", `${count} ${count === 1 ? "child" : "children"}`)}${agents.length === 0 ? "" : ` ${theme.fg("accent", agents)}`}`,
  ]);
};

export const renderSubagentResult = (
  result: SubagentRenderResult,
  options: SubagentRenderOptions,
  theme: RenderTheme,
): Component => {
  const details = result.details;
  if (details === undefined) {
    return componentFromLines([
      theme.fg("dim", "Subagent details unavailable"),
    ]);
  }
  return componentFromLines(
    details.phase === "progress"
      ? progressLines(
          details.progress,
          options.expanded,
          details.diagnostics,
          theme,
        )
      : resultLines(
          details.results,
          options.expanded,
          details.diagnostics,
          theme,
        ),
  );
};
