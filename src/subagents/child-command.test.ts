import { describe, expect, it } from "vitest";
import {
  buildChildCommand,
  type CurrentProcessInfo,
  type ParentSnapshot,
} from "./child-command";

const snapshot: ParentSnapshot = {
  provider: "openai-codex",
  modelId: "gpt-5.4",
  thinkingLevel: "high",
};

const processInfo = (
  overrides: Partial<CurrentProcessInfo> = {},
): CurrentProcessInfo => ({
  execPath: "/usr/bin/node",
  scriptPath: "/opt/pi/dist/cli.js",
  scriptExists: () => true,
  ...overrides,
});

describe("buildChildCommand", () => {
  it("builds the exact isolated child arguments", () => {
    const command = buildChildCommand(snapshot, processInfo());

    expect(command).toEqual({
      command: "/usr/bin/node",
      args: [
        "/opt/pi/dist/cli.js",
        "--mode",
        "text",
        "--print",
        "--no-session",
        "--model",
        "openai-codex/gpt-5.4",
        "--thinking",
        "high",
        "--tools",
        "read,bash,edit,write,grep,find,ls",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
      ],
    });
    expect(command.args).not.toContain("--no-context-files");
    expect(command.args).not.toContain("--system-prompt");
    expect(command.args).not.toContain("--append-system-prompt");
  });

  it("uses a packaged Pi executable without a script prefix", () => {
    expect(
      buildChildCommand(
        snapshot,
        processInfo({
          execPath: "/opt/pi/bin/pi",
          scriptPath: undefined,
          scriptExists: () => false,
        }),
      ).command,
    ).toBe("/opt/pi/bin/pi");
  });

  it("falls back to pi for generic runtimes without a reusable script", () => {
    const missing = buildChildCommand(
      snapshot,
      processInfo({ scriptExists: () => false }),
    );
    const virtual = buildChildCommand(
      snapshot,
      processInfo({ scriptPath: "/$bunfs/root/pi" }),
    );

    expect(missing.command).toBe("pi");
    expect(virtual.command).toBe("pi");
    expect(missing.args[0]).toBe("--mode");
    expect(virtual.args[0]).toBe("--mode");
  });

  it("passes extension-only provider names through without weakening isolation", () => {
    const command = buildChildCommand(
      { ...snapshot, provider: "extension-only-provider" },
      processInfo(),
    );

    expect(command.args).toContain(
      "extension-only-provider/" + snapshot.modelId,
    );
    expect(command.args).toContain("--no-extensions");
  });
});
