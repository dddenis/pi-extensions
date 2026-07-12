import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentDirectory } from "./agent-directory";

describe("resolveAgentDirectory", () => {
  it("uses the default for unset and empty configuration", () => {
    expect(resolveAgentDirectory(path.posix, undefined, "/home/me")).toBe(
      "/home/me/.pi/agent",
    );
    expect(resolveAgentDirectory(path.posix, "", "/home/me")).toBe(
      "/home/me/.pi/agent",
    );
  });

  it("expands only Pi-compatible home forms", () => {
    expect(resolveAgentDirectory(path.posix, "~", "/home/me")).toBe("/home/me");
    expect(resolveAgentDirectory(path.posix, "~/custom", "/home/me")).toBe(
      "/home/me/custom",
    );
    expect(
      resolveAgentDirectory(path.win32, "~\\custom", "C:\\Users\\me"),
    ).toBe("C:\\Users\\me\\custom");
    expect(resolveAgentDirectory(path.posix, "~other/custom", "/home/me")).toBe(
      path.posix.resolve("~other/custom"),
    );
  });
});
