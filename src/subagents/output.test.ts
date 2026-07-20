import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  formatProgress,
  formatSubagentResults,
  makeHeadAccumulator,
  makeTailAccumulator,
  sanitizeTerminalText,
  type SubagentTaskResult,
} from "./output";

const completed = (
  description: string,
  output: string,
): SubagentTaskResult => ({
  description,
  cwd: "/repo",
  status: "completed",
  exitCode: 0,
  signal: null,
  output,
});

describe("subagent output safety", () => {
  it("removes split ANSI, OSC, DEL, C0, and C1 controls", () => {
    const head = makeHeadAccumulator({ maxBytes: 200, maxLines: 20 });
    head.append("\u001b]8;;https://unsafe.example");
    head.append("\u0007link\u001b]8;;\u001b\\ \u001b[31mred\u001b[0m");
    head.append("\u0000\u007f\u0090hidden\u009ctab\tline\n");
    head.finish();

    expect(head.snapshot()).toEqual({
      text: "link redtab\tline\n",
      truncated: false,
    });
    expect(sanitizeTerminalText("safe\u001b[31")).toBe("safe");
  });

  it("keeps stdout from the head and stderr from the tail", () => {
    const head = makeHeadAccumulator({ maxBytes: 32, maxLines: 2 });
    head.append("first\nsecond\nthird\n");
    head.finish();

    const tail = makeTailAccumulator({ maxBytes: 32, maxLines: 2 });
    tail.append("first\nsecond\nthird\n");
    tail.finish();

    expect(head.snapshot().text).toContain("first");
    expect(head.snapshot().text).not.toContain("third");
    expect(tail.snapshot().text).toContain("third");
    expect(tail.snapshot().text).not.toContain("first");
    expect(head.snapshot().truncated).toBe(true);
    expect(tail.snapshot().truncated).toBe(true);
    expect(Buffer.byteLength(head.snapshot().text, "utf8")).toBeLessThanOrEqual(
      32,
    );
    expect(Buffer.byteLength(tail.snapshot().text, "utf8")).toBeLessThanOrEqual(
      32,
    );
  });

  it("does not split multi-byte characters at byte boundaries", () => {
    const head = makeHeadAccumulator({ maxBytes: 17, maxLines: 10 });
    head.append("ééééééééé");
    head.finish();
    expect(head.snapshot().text).not.toContain("�");
  });

  it("normalizes split CRLF and standalone carriage returns to LF", () => {
    const head = makeHeadAccumulator({ maxBytes: 200, maxLines: 20 });
    head.append("first\r");
    head.append("\nsecond\rthird");
    head.finish();

    expect(head.snapshot().text).toBe("first\nsecond\nthird");
    expect(head.snapshot().text).not.toContain("\r");
  });

  it("keeps omission markers inside tiny limits and rotates a truncated tail", () => {
    const head = makeHeadAccumulator({ maxBytes: 12, maxLines: 1 });
    head.append("abcdefghijklmnopqrstuvwxyz");
    head.finish();

    const tail = makeTailAccumulator({ maxBytes: 24, maxLines: 2 });
    tail.append("old-old-old-old\n");
    tail.append("middle-middle\n");
    tail.append("newest");
    tail.finish();

    expect(Buffer.byteLength(head.snapshot().text, "utf8")).toBeLessThanOrEqual(
      12,
    );
    expect(head.snapshot().text).toContain("omitted");
    expect(tail.snapshot().text).toContain("newest");
    expect(tail.snapshot().text).not.toContain("old-old");
  });

  it("formats exact coarse progress", () => {
    expect(formatProgress(0, 5)).toBe("Subagents: 0/5 completed");
    expect(formatProgress(5, 5)).toBe("Subagents: 5/5 completed");
  });
});

describe("formatSubagentResults", () => {
  it("renders ordered statuses and outputs, with stderr only for failures", () => {
    const results: ReadonlyArray<SubagentTaskResult> = [
      { ...completed("first", ""), stderr: "successful warning" },
      {
        description: "second",
        cwd: "/repo/two",
        status: "failed",
        exitCode: 7,
        signal: null,
        output: "partial",
        stderr: "boom",
      },
      {
        description: "third",
        cwd: "/repo/three",
        status: "failed",
        exitCode: null,
        signal: "SIGTERM",
        output: "",
      },
    ];

    const text = formatSubagentResults(results);
    expect(text.indexOf("1. completed — first")).toBeLessThan(
      text.indexOf("2. failed — second"),
    );
    expect(text.indexOf("[1] first")).toBeLessThan(text.indexOf("[3] third"));
    expect(text).toContain("(no stdout)");
    expect(text).toContain("boom");
    expect(text).toContain("(exit 7)");
    expect(text).toContain("(signal SIGTERM)");
    expect(text).not.toContain("successful warning");
  });

  it("prevents descriptions and cwd values from injecting aggregate lines", () => {
    const result = {
      ...completed("\u001b[31mfirst\nforged status", "safe"),
      cwd: "/repo\rforged cwd",
    };
    const text = formatSubagentResults([result]);

    expect(text).toContain("first forged status");
    expect(text).toContain("cwd: /repo forged cwd");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\r");
  });

  it("reserves status and label space before sharing aggregate output", () => {
    const results = [
      completed("first", "A".repeat(500)),
      completed("second", "B".repeat(500)),
      completed("third", "C".repeat(500)),
    ];
    const text = formatSubagentResults(results, {
      maxBytes: 300,
      maxLines: 30,
    });

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(300);
    expect(text.split("\n").length).toBeLessThanOrEqual(30);
    expect(text).toContain("1. completed — first");
    expect(text).toContain("3. completed — third");
    expect(text).toContain("[1] first");
    expect(text).toContain("[3] third");
    expect(text).toContain("omitted");
  });

  it("carries unused early capacity into a later task asymmetrically", () => {
    const limits = { maxBytes: 360, maxLines: 30 };
    const withUnusedEarlyCapacity = formatSubagentResults(
      [
        completed("short first", "ok"),
        completed("large second", "B".repeat(500)),
      ],
      limits,
    );
    const withConsumedEarlyCapacity = formatSubagentResults(
      [
        completed("large first", "A".repeat(500)),
        completed("large second", "B".repeat(500)),
      ],
      limits,
    );
    const retainedBs = (text: string): number =>
      Array.from(text).filter((character) => character === "B").length;

    expect(retainedBs(withUnusedEarlyCapacity)).toBeGreaterThan(
      retainedBs(withConsumedEarlyCapacity),
    );
    expect(withUnusedEarlyCapacity).toContain("[1] short first");
    expect(withUnusedEarlyCapacity).toContain("[2] large second");
  });

  it("does not read task bodies when every section must be omitted", () => {
    let outputReads = 0;
    const result = {
      description: "omitted task",
      cwd: "/repo",
      status: "completed",
      exitCode: 0,
      signal: null,
      get output(): string {
        outputReads += 1;
        return "unneeded".repeat(10_000);
      },
    } satisfies SubagentTaskResult;

    const text = formatSubagentResults([result], {
      maxBytes: 60,
      maxLines: 2,
    });

    expect(outputReads).toBe(0);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(60);
  });

  it("reports status omission when a huge task list consumes the budget", () => {
    const results = Array.from({ length: 100 }, (_, index) =>
      completed("task-" + String(index + 1), "done"),
    );
    const text = formatSubagentResults(results, {
      maxBytes: 180,
      maxLines: 8,
    });
    expect(text).toContain("task statuses omitted");
    expect(text).toContain("task output sections omitted");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(180);
  });
});
