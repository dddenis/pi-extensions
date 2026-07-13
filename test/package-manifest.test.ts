import { describe, expect, it } from "vitest";
import packageJson from "../package.json";

describe("Pi package manifest", () => {
  it("loads exactly the supported entrypoints in stable order", () => {
    expect(packageJson.pi.extensions).toEqual([
      "./src/attention-hooks/index.ts",
      "./src/custom-footer/index.ts",
      "./src/history-picker/index.ts",
      "./src/subagents/index.ts",
    ]);
    expect(packageJson.pi.extensions).not.toContain(
      "./src/subagents/completion.ts",
    );
  });

  it("declares directly imported runtime and Pi-hosted APIs", () => {
    expect(packageJson.dependencies).toMatchObject({
      effect: expect.any(String),
      typebox: expect.any(String),
    });
    expect(packageJson.peerDependencies).toMatchObject({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
    });
    expect(packageJson.devDependencies).toMatchObject({
      "@earendil-works/pi-ai": "^0.80.6",
      "@earendil-works/pi-coding-agent": "^0.80.6",
      "@earendil-works/pi-tui": "^0.80.6",
    });
  });
});
