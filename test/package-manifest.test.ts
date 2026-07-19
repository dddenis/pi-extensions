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
  });

  it("declares directly imported Pi-hosted APIs", () => {
    expect(packageJson.peerDependencies).toMatchObject({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
    });
    expect(packageJson.devDependencies).toMatchObject({
      "@earendil-works/pi-ai": "^0.80.7",
      "@earendil-works/pi-coding-agent": "^0.80.7",
      "@earendil-works/pi-tui": "^0.80.7",
    });
  });
});
