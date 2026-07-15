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
    name: "alpha",
    description: "Inspect contracts",
    model: "provider/model",
    thinking: "medium",
    source: "global",
    definitionPath: "/agents/alpha.md",
  },
  toolInheritance: {
    parentActiveToolNames: ["read", "grep", "subagent"],
    effectiveToolNames: ["read", "grep", "complete_subagent"],
    providerExtensions: ["/ext/alpha.ts"],
    diagnostics: [],
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
  it("defaults an omitted or undefined agent to general", () => {
    expect(decodeTasks({ tasks: [{ task: " inspect " }] })).toEqual({
      tasks: [{ agent: "general", task: "inspect" }],
    });
    expect(
      decodeTasks({ tasks: [{ agent: undefined, task: "inspect" }] }),
    ).toEqual({ tasks: [{ agent: "general", task: "inspect" }] });
  });

  it("accepts three tasks", () => {
    expect(
      decodeTasks({
        tasks: [
          { agent: "alpha", task: "inspect" },
          { agent: "beta", task: "collect evidence", cwd: " /repo/docs " },
          { agent: "gamma", task: "draft changes" },
        ],
      }),
    ).toEqual({
      tasks: [
        { agent: "alpha", task: "inspect" },
        { agent: "beta", task: "collect evidence", cwd: "/repo/docs" },
        { agent: "gamma", task: "draft changes" },
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
      decodeTasks({ tasks: [{ agent: "alpha", task: "   " }] }),
    ).toThrow();
  });

  it("accepts only identity, model, and thinking frontmatter", () => {
    expect(
      decodeAgentFrontmatter({
        name: " alpha ",
        description: " inspect contracts ",
        model: " provider/model ",
        thinking: "medium",
      }),
    ).toEqual({
      name: "alpha",
      description: "inspect contracts",
      model: "provider/model",
      thinking: "medium",
    });

    expect(() =>
      decodeAgentFrontmatter({
        name: "legacy",
        description: "Legacy allowlist",
        tools: "read, grep",
      }),
    ).toThrow();
  });

  it("rejects mutation classification as unknown frontmatter", () => {
    expect(() =>
      decodeAgentFrontmatter({
        name: "alpha",
        description: "Inspect contracts",
        writer: false,
      }),
    ).toThrow();
  });

  it("rejects multiline or unknown frontmatter fields", () => {
    expect(() =>
      decodeAgentFrontmatter({ name: "alpha\nbeta", description: "bad" }),
    ).toThrow();
    expect(() =>
      decodeAgentFrontmatter({
        name: "alpha",
        description: "bad\nidea",
      }),
    ).toThrow();
    expect(() =>
      decodeAgentFrontmatter({
        name: "alpha",
        description: "Inspect",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects invalid frontmatter thinking", () => {
    expect(() =>
      decodeAgentFrontmatter({
        name: "alpha",
        description: "Inspect",
        thinking: "turbo",
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

  it("accepts manifests without mutation classification", () => {
    expect(decodeRunManifest(manifest)).toEqual(manifest);
    expect(decodeRunManifestJson(JSON.stringify(manifest))).toEqual(manifest);
    expect(() =>
      decodeRunManifest({
        ...manifest,
        agent: { ...manifest.agent, writer: false },
      }),
    ).toThrow();

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

  it("preserves duplicate and transport-unsafe parent active-name evidence", () => {
    const parentActiveToolNames = [
      "read",
      "read",
      " subagent ",
      "subagent,probe",
      "",
    ];
    const decoded = decodeRunManifest({
      ...manifest,
      toolInheritance: {
        ...manifest.toolInheritance,
        parentActiveToolNames,
        effectiveToolNames: ["read", "complete_subagent"],
      },
    });
    const decodedJson = decodeRunManifestJson(JSON.stringify(decoded));

    parentActiveToolNames[0] = "mutated";
    expect(decoded.toolInheritance.parentActiveToolNames).toEqual([
      "read",
      "read",
      " subagent ",
      "subagent,probe",
      "",
    ]);
    expect(decodedJson.toolInheritance.parentActiveToolNames).toEqual(
      decoded.toolInheritance.parentActiveToolNames,
    );
    expect(Object.isFrozen(decoded.toolInheritance.parentActiveToolNames)).toBe(
      true,
    );
  });

  it("rejects transport-unsafe or duplicate effective tool names", () => {
    for (const effectiveToolNames of [
      ["subagent,probe", "complete_subagent"],
      [" read ", "complete_subagent"],
      ["read", "read", "complete_subagent"],
    ]) {
      expect(() =>
        decodeRunManifest({
          ...manifest,
          toolInheritance: {
            ...manifest.toolInheritance,
            effectiveToolNames,
          },
        }),
      ).toThrow();
    }
  });

  it("enforces builtin/global provenance and one completion tool", () => {
    expect(
      decodeRunManifest({
        ...manifest,
        agent: {
          name: "general",
          description: "General-purpose isolated task executor",
          model: "provider/model",
          thinking: "medium",
          source: "builtin",
        },
      }).agent,
    ).not.toHaveProperty("definitionPath");

    expect(() =>
      decodeRunManifest({
        ...manifest,
        agent: { ...manifest.agent, source: "builtin" },
      }),
    ).toThrow();
    expect(() =>
      decodeRunManifest({
        ...manifest,
        agent: { ...manifest.agent, definitionPath: undefined },
      }),
    ).toThrow();
    expect(() =>
      decodeRunManifest({
        ...manifest,
        toolInheritance: {
          ...manifest.toolInheritance,
          effectiveToolNames: ["read"],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRunManifest({
        ...manifest,
        toolInheritance: {
          ...manifest.toolInheritance,
          effectiveToolNames: ["complete_subagent", "complete_subagent"],
        },
      }),
    ).toThrow();
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
        agent: "alpha",
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
      agent: "alpha",
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
