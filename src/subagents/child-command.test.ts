import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildChildInvocation,
  makeChildExecutableSelector,
  type ChildExecutableSelector,
} from "./child-command";
import type { ResolvedTask } from "./preflight";
import type { RunArtifacts } from "./schemas";

const taskText = "Inspect the private implementation details.";
const rolePrompt = "Act as a careful agent for private implementation details.";

const resolvedTask = (
  toolInheritance: ResolvedTask["toolInheritance"] = {
    parentActiveToolNames: ["read", "web_search", "subagent"],
    effectiveToolNames: ["read", "web_search", "complete_subagent"],
    providerExtensions: [
      "/extensions/provider.ts",
      "/extensions/../extensions/provider.ts",
    ],
    diagnostics: [],
  },
): ResolvedTask => ({
  index: 0,
  task: taskText,
  cwd: "/repo/worktree",
  agent: {
    name: "alpha",
    description: "Inspect implementation",
    rolePrompt,
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    source: "global",
    definitionPath: "/agents/alpha.md",
  },
  toolInheritance,
});

const artifacts: RunArtifacts = {
  runId: "run-1",
  runDirectory: "/runs/run-1",
  manifestPath: "/runs/run-1/run.json",
  taskPath: "/runs/run-1/task.md",
  systemPromptPath: "/runs/run-1/system-prompt.md",
  eventsPath: "/runs/run-1/events.jsonl",
  stderrPath: "/runs/run-1/stderr.log",
  statusPath: "/runs/run-1/status.json",
};

const runtime = (
  execPath: string,
  argv: ReadonlyArray<string>,
  realScripts: ReadonlyArray<string> = [],
): ChildExecutableSelector =>
  makeChildExecutableSelector({
    execPath,
    argv,
    isFile: (candidate) => realScripts.includes(candidate),
  });

describe("buildChildInvocation", () => {
  it("constructs the exact shell-free argv and inherited child environment", () => {
    const currentPiScript = "/opt/pi/dist/cli.js";
    const completionEntrypoint = "/repo/src/subagents/index.ts";
    const parentEnv = { HOME: "/home/test", PI_SUBAGENT_CHILD: "old" };

    const invocation = buildChildInvocation(
      {
        task: resolvedTask(),
        artifacts,
        parentEnv,
        completionEntrypoint,
      },
      runtime(
        "/usr/local/bin/bun",
        ["bun", currentPiScript],
        [currentPiScript],
      ),
    );

    expect(invocation).toEqual({
      command: "/usr/local/bin/bun",
      args: [
        currentPiScript,
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--no-extensions",
        "--extension",
        completionEntrypoint,
        "--extension",
        "/extensions/provider.ts",
        "--model",
        "openai-codex/gpt-5.4",
        "--thinking",
        "high",
        "--tools",
        "read,web_search,complete_subagent",
        "--append-system-prompt",
        artifacts.systemPromptPath,
        `@${artifacts.taskPath}`,
      ],
      cwd: resolvedTask().cwd,
      env: { HOME: "/home/test", PI_SUBAGENT_CHILD: "1" },
    });
    expect([invocation.command, ...invocation.args]).not.toContain(taskText);
    expect([invocation.command, ...invocation.args]).not.toContain(rolePrompt);
  });

  it("always passes an explicit completion-only tool list", () => {
    const invocation = buildChildInvocation(
      {
        task: resolvedTask({
          parentActiveToolNames: ["subagent"],
          effectiveToolNames: ["complete_subagent"],
          providerExtensions: [],
          diagnostics: [],
        }),
        artifacts,
        parentEnv: {},
        completionEntrypoint: "/repo/src/subagents/index.ts",
      },
      runtime("/compiled/pi", ["/compiled/pi"]),
    );

    const toolsIndex = invocation.args.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    expect(invocation.args[toolsIndex + 1]).toBe("complete_subagent");
    expect(invocation.args.filter((value) => value === "--tools")).toHaveLength(
      1,
    );
  });

  it("canonicalizes and deduplicates all explicit extension paths", () => {
    const completionEntrypoint = path.join("/repo", "src/subagents/index.ts");
    const task = resolvedTask();
    const invocation = buildChildInvocation(
      {
        task: {
          ...task,
          toolInheritance: {
            ...task.toolInheritance,
            providerExtensions: [
              "/repo/src/subagents/./index.ts",
              "/extensions/a/../provider.ts",
              "/extensions/provider.ts",
            ],
          },
        },
        artifacts,
        parentEnv: {},
        completionEntrypoint,
      },
      runtime("/compiled/pi", ["/compiled/pi"]),
    );

    const extensions = invocation.args.flatMap((argument, index, args) =>
      argument === "--extension" && args[index + 1] !== undefined
        ? [args[index + 1]]
        : [],
    );
    expect(extensions).toEqual([
      "/repo/src/subagents/index.ts",
      "/extensions/provider.ts",
    ]);
  });

  it("loads a selected provider without activating its unrelated tools", () => {
    const invocation = buildChildInvocation({
      task: resolvedTask({
        parentActiveToolNames: ["inherited_probe", "subagent"],
        effectiveToolNames: ["inherited_probe", "complete_subagent"],
        providerExtensions: ["/extensions/multi-tool-provider.ts"],
        diagnostics: [],
      }),
      artifacts,
      parentEnv: {},
      completionEntrypoint: "/completion.ts",
    });
    const toolsIndex = invocation.args.indexOf("--tools");
    const toolsValue = invocation.args[toolsIndex + 1];
    expect(toolsValue).toBe("inherited_probe,complete_subagent");
    expect(
      toolsValue
        ?.split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ).toEqual(["inherited_probe", "complete_subagent"]);
    expect(invocation.args).toContain("/extensions/multi-tool-provider.ts");
    expect(toolsValue).not.toContain("subagent,");
    expect(toolsValue).not.toContain("provider_extra");
  });

  it("runs a real argv[1] Pi script through process.execPath", () => {
    const currentPiScript = "/opt/pi/cli.mjs";
    const invocation = buildChildInvocation(
      {
        task: resolvedTask(),
        artifacts,
        parentEnv: {},
        completionEntrypoint: "/completion.ts",
      },
      runtime("/usr/bin/node", ["node", currentPiScript], [currentPiScript]),
    );

    expect(invocation.command).toBe("/usr/bin/node");
    expect(invocation.args[0]).toBe(currentPiScript);
  });

  it("runs every compiled non-generic executable directly even with a different real argv[1]", () => {
    const unrelatedRealFile = "/repo/user-argument.md";
    const invocation = buildChildInvocation(
      {
        task: resolvedTask(),
        artifacts,
        parentEnv: {},
        completionEntrypoint: "/completion.ts",
      },
      runtime(
        "/opt/bin/pi-bundle",
        ["/opt/bin/pi-bundle", unrelatedRealFile],
        [unrelatedRealFile],
      ),
    );

    expect(invocation.command).toBe("/opt/bin/pi-bundle");
    expect(invocation.args[0]).toBe("--mode");
    expect(invocation.args).not.toContain(unrelatedRealFile);
  });

  it("makes a selected relative interpreter script absolute before changing cwd", () => {
    const relativeScript = "dist/pi-cli.js";
    const invocation = buildChildInvocation(
      {
        task: resolvedTask(),
        artifacts,
        parentEnv: {},
        completionEntrypoint: "/completion.ts",
      },
      runtime("/usr/local/bin/bun", ["bun", relativeScript], [relativeScript]),
    );

    expect(invocation.command).toBe("/usr/local/bin/bun");
    expect(invocation.args[0]).toBe(path.resolve(relativeScript));
  });

  it("falls back to pi for generic Bun or Node without a real script", () => {
    for (const execPath of ["/usr/local/bin/bun", "/usr/bin/node"]) {
      const invocation = buildChildInvocation(
        {
          task: resolvedTask(),
          artifacts,
          parentEnv: {},
          completionEntrypoint: "/completion.ts",
        },
        runtime(execPath, [path.basename(execPath), "/missing/pi.js"]),
      );

      expect(invocation.command).toBe("pi");
      expect(invocation.args[0]).toBe("--mode");
    }
  });
});
