import { describe, expect, it } from "vitest";
import {
  CompletionValidationError,
  InvalidWorkingDirectoryError,
  formatSubagentError,
} from "./errors";
import {
  CompletionResultSchema,
  decodeAgentFrontmatter,
  decodeCompletion,
  decodeRunManifest,
  decodeRunManifestJson,
  decodeRunResult,
  decodeRunStatusRecord,
  decodeRunStatusRecordJson,
  decodeSubagentToolDetails,
  decodeTasks,
} from "./schemas";

const iso = "2026-07-12T10:11:12.345Z";

const manifest = {
  runId: "run-1",
  createdAt: iso,
  task: {
    index: 0,
    cwd: "/repo",
  },
  agent: {
    name: "reviewer",
    description: "Inspect contracts",
    model: "provider/model",
    thinking: "medium",
    tools: ["read", "grep"],
    writer: false,
    providerExtensions: ["/ext/reviewer.ts"],
    definitionPath: "/agents/reviewer.md",
  },
  artifacts: {
    runId: "run-1",
    runDirectory: "/runs/run-1",
    manifestPath: "/runs/run-1/run.json",
    taskPath: "/runs/run-1/task.md",
    systemPromptPath: "/runs/run-1/system-prompt.md",
    eventsPath: "/runs/run-1/events.jsonl",
    stderrPath: "/runs/run-1/stderr.log",
    statusPath: "/runs/run-1/status.json",
  },
};

describe("subagent schemas", () => {
  it("accepts a single trimmed task", () => {
    expect(
      decodeTasks({ tasks: [{ agent: " reviewer ", task: " inspect " }] }),
    ).toEqual({
      tasks: [{ agent: "reviewer", task: "inspect" }],
    });
  });

  it("accepts three tasks", () => {
    expect(
      decodeTasks({
        tasks: [
          { agent: "reviewer", task: "inspect" },
          { agent: "reader", task: "collect evidence", cwd: " /repo/docs " },
          { agent: "writer", task: "draft changes" },
        ],
      }),
    ).toEqual({
      tasks: [
        { agent: "reviewer", task: "inspect" },
        { agent: "reader", task: "collect evidence", cwd: "/repo/docs" },
        { agent: "writer", task: "draft changes" },
      ],
    });
  });

  it("rejects zero or four tasks", () => {
    expect(() => decodeTasks({ tasks: [] })).toThrow();
    expect(() =>
      decodeTasks({
        tasks: [
          { agent: "one", task: "1" },
          { agent: "two", task: "2" },
          { agent: "three", task: "3" },
          { agent: "four", task: "4" },
        ],
      }),
    ).toThrow();
  });

  it("rejects whitespace-only agent or task", () => {
    expect(() =>
      decodeTasks({ tasks: [{ agent: "   ", task: "inspect" }] }),
    ).toThrow();
    expect(() =>
      decodeTasks({ tasks: [{ agent: "reviewer", task: "   " }] }),
    ).toThrow();
  });

  it("accepts valid frontmatter and preserves optional absence", () => {
    expect(
      decodeAgentFrontmatter({
        name: " reviewer ",
        description: " inspect contracts ",
        model: " provider/model ",
        thinking: "medium",
        tools: " read, grep ",
        writer: false,
      }),
    ).toEqual({
      name: "reviewer",
      description: "inspect contracts",
      model: "provider/model",
      thinking: "medium",
      tools: ["read", "grep"],
      writer: false,
    });

    expect(
      Object.prototype.hasOwnProperty.call(
        decodeAgentFrontmatter({
          name: "reader",
          description: "Inspect only",
        }),
        "tools",
      ),
    ).toBe(false);
  });

  it("rejects multiline or unknown frontmatter fields", () => {
    expect(() =>
      decodeAgentFrontmatter({ name: "reader\nwriter", description: "bad" }),
    ).toThrow();
    expect(() =>
      decodeAgentFrontmatter({
        name: "reader",
        description: "bad\nidea",
      }),
    ).toThrow();
    expect(() =>
      decodeAgentFrontmatter({
        name: "reader",
        description: "Inspect",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects invalid frontmatter thinking, writer, and tools", () => {
    expect(() =>
      decodeAgentFrontmatter({
        name: "reader",
        description: "Inspect",
        thinking: "turbo",
      }),
    ).toThrow();
    expect(() =>
      decodeAgentFrontmatter({
        name: "reader",
        description: "Inspect",
        writer: "false",
      }),
    ).toThrow();
    expect(() =>
      decodeAgentFrontmatter({
        name: "reader",
        description: "Inspect",
        tools: "   ",
      }),
    ).toThrow();
    expect(() =>
      decodeAgentFrontmatter({
        name: "reader",
        description: "Inspect",
        tools: "read, grep, read",
      }),
    ).toThrow();
  });

  it("accepts completion summaries at 1 and 500 Unicode code points", () => {
    expect(decodeCompletion({ status: "DONE", summary: " x " })).toEqual({
      status: "DONE",
      summary: "x",
    });
    const summary = "😀".repeat(500);
    expect(
      decodeCompletion({
        status: "DONE_WITH_CONCERNS",
        summary: `  ${summary}  `,
        reportPath: " /tmp/report.md ",
      }),
    ).toEqual({
      status: "DONE_WITH_CONCERNS",
      summary,
      reportPath: "/tmp/report.md",
    });
  });

  it("rejects invalid completion summaries and report paths", () => {
    expect(() =>
      decodeCompletion({ status: "DONE", summary: "😀".repeat(501) }),
    ).toThrow();
    expect(() =>
      decodeCompletion({
        status: "DONE",
        summary: "done",
        reportPath: "reports/out.md",
      }),
    ).toThrow();
    expect(() =>
      decodeCompletion({
        status: "DONE",
        summary: "done\nnext",
      }),
    ).toThrow();
  });

  it("rejects terminal controls in completion summaries", () => {
    for (const control of [
      "\u001b[31mCSI",
      "bell\u0007",
      "c1\u0085",
      "\u001b_payload\u001b\\",
      "\u001b]52;c;Y2xpcGJvYXJk\u0007",
    ]) {
      expect(() =>
        decodeCompletion({ status: "DONE", summary: `unsafe ${control}` }),
      ).toThrow();
    }
  });

  it("accepts valid manifest and status records", () => {
    expect(decodeRunManifest(manifest)).toEqual(manifest);
    expect(decodeRunManifestJson(JSON.stringify(manifest))).toEqual(manifest);

    expect(
      decodeRunStatusRecord({
        status: "DONE",
        updatedAt: iso,
        summary: "Finished review",
        reportPath: "/tmp/report.md",
        diagnostics: ["warning"],
      }),
    ).toEqual({
      status: "DONE",
      updatedAt: iso,
      summary: "Finished review",
      reportPath: "/tmp/report.md",
      diagnostics: ["warning"],
    });

    expect(
      decodeRunStatusRecordJson(
        JSON.stringify({ status: "RUNNING", updatedAt: iso }),
      ),
    ).toEqual({ status: "RUNNING", updatedAt: iso });
  });

  it("requires canonical UTC ISO timestamps for manifests and statuses", () => {
    expect(decodeRunManifest({ ...manifest, createdAt: iso }).createdAt).toBe(
      iso,
    );
    expect(
      decodeRunStatusRecord({ status: "RUNNING", updatedAt: iso }).updatedAt,
    ).toBe(iso);

    for (const timestamp of ["2026-07-12", "2026-07-12T10:11:12Z"] as const) {
      expect(() =>
        decodeRunManifest({ ...manifest, createdAt: timestamp }),
      ).toThrow();
      expect(() =>
        decodeRunStatusRecord({ status: "RUNNING", updatedAt: timestamp }),
      ).toThrow();
    }
  });

  it("rejects malformed manifest or status json", () => {
    expect(() => decodeRunManifestJson("{")).toThrow();
    expect(() => decodeRunStatusRecordJson("not json")).toThrow();
    expect(() =>
      decodeRunStatusRecord({ status: "DONE", updatedAt: "today" }),
    ).toThrow();
  });

  it("decodes run results and completion tool details", () => {
    expect(
      decodeRunResult({
        runId: "run-1",
        agent: "reviewer",
        status: "DONE",
        summary: "Completed review",
        reportPath: "/tmp/report.md",
        exitCode: 0,
        signal: null,
        usage: {
          input: 10,
          output: 20,
          cacheRead: 1,
          cacheWrite: 2,
          cost: 0.12,
          turns: 3,
        },
        artifacts: manifest.artifacts,
        diagnostics: ["warning"],
      }),
    ).toEqual({
      runId: "run-1",
      agent: "reviewer",
      status: "DONE",
      summary: "Completed review",
      reportPath: "/tmp/report.md",
      exitCode: 0,
      signal: null,
      usage: {
        input: 10,
        output: 20,
        cacheRead: 1,
        cacheWrite: 2,
        cost: 0.12,
        turns: 3,
      },
      artifacts: manifest.artifacts,
      diagnostics: ["warning"],
    });

    expect(
      decodeSubagentToolDetails({
        status: "NEEDS_CONTEXT",
        summary: "Need the missing fixture",
      }),
    ).toEqual({
      status: "NEEDS_CONTEXT",
      summary: "Need the missing fixture",
    });

    expect(CompletionResultSchema).toBeDefined();
  });

  it("formats tagged errors with tag, subject, and message once", () => {
    expect(
      formatSubagentError(
        new InvalidWorkingDirectoryError({
          cwd: "/repo/missing",
          message: "Directory does not exist",
        }),
      ),
    ).toBe(
      "InvalidWorkingDirectoryError (/repo/missing): Directory does not exist",
    );

    expect(
      formatSubagentError(
        new CompletionValidationError({
          status: "DONE",
          message: "Report path must be absolute",
          reportPath: "report.md",
        }),
      ),
    ).toBe("CompletionValidationError (DONE): Report path must be absolute");
  });
});
