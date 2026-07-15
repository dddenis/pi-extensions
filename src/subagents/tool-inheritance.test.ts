import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { FileSystemServiceTest } from "../../test/services/file-system";
import { FileSystemError, type FileMetadata } from "../services/file-system";
import { resolveToolInheritance } from "./tool-inheritance";

const file = { kind: "file" as const, mtimeMs: 0, mode: 0o644 };
const directory = { kind: "directory" as const, mtimeMs: 0, mode: 0o755 };

const run = (
  parent: Parameters<typeof resolveToolInheritance>[0],
  config: Parameters<typeof FileSystemServiceTest.layer>[0] = {},
) =>
  resolveToolInheritance(parent).pipe(
    Effect.provide(FileSystemServiceTest.layer(config)),
  );

describe("resolveToolInheritance", () => {
  it.effect(
    "inherits active builtins in order and filters reserved names",
    () =>
      Effect.gen(function* () {
        const result = yield* run({
          cwd: "/repo",
          activeToolNames: ["bash", "subagent", "read", "complete_subagent"],
          toolProviders: [
            { name: "read", source: "builtin", path: "<builtin:read>" },
            { name: "inactive", source: "builtin", path: "<builtin:inactive>" },
            { name: "bash", source: "builtin", path: "<builtin:bash>" },
          ],
        });
        expect(result).toEqual({
          parentActiveToolNames: [
            "bash",
            "subagent",
            "read",
            "complete_subagent",
          ],
          effectiveToolNames: ["bash", "read", "complete_subagent"],
          providerExtensions: [],
          diagnostics: [],
        });
      }),
  );

  it.effect(
    "omits names that cannot round-trip through Pi's tool-list transport",
    () =>
      Effect.gen(function* () {
        const ansiName = "subagent,\u001b[31mprobe";
        const result = yield* run(
          {
            cwd: "/repo",
            activeToolNames: ["subagent,probe", " subagent ", ansiName],
            toolProviders: [
              {
                name: "subagent,probe",
                source: "local",
                path: "/ext/inherited.ts",
              },
              {
                name: " subagent ",
                source: "local",
                path: "/ext/inherited.ts",
              },
              {
                name: ansiName,
                source: "local",
                path: "/ext/inherited.ts",
              },
            ],
          },
          {
            metadata: new Map([["/ext/inherited.ts", file]]),
            realPaths: new Map([
              ["/ext/inherited.ts", "/canonical/inherited.ts"],
            ]),
          },
        );

        expect(result.parentActiveToolNames).toEqual([
          "subagent,probe",
          " subagent ",
          ansiName,
        ]);
        expect(result.effectiveToolNames).toEqual(["complete_subagent"]);
        expect(result.providerExtensions).toEqual([]);
        expect(result.diagnostics).toHaveLength(3);
        expect(result.diagnostics[0]).toContain("subagent,probe");
        expect(result.diagnostics[1]).toContain("subagent");
        for (const message of result.diagnostics) {
          expect(message).toContain("cannot be represented by Pi --tools");
          expect(message).not.toContain(String.fromCharCode(0x1b));
        }
      }),
  );

  it.effect(
    "preserves duplicate parent evidence while keeping effective names unique",
    () =>
      Effect.gen(function* () {
        const activeToolNames = ["read", "read", "subagent"];
        const result = yield* run({
          cwd: "/repo",
          activeToolNames,
          toolProviders: [
            { name: "read", source: "builtin", path: "<builtin:read>" },
          ],
        });

        activeToolNames[0] = "mutated";
        expect(result.parentActiveToolNames).toEqual([
          "read",
          "read",
          "subagent",
        ]);
        expect(result.effectiveToolNames).toEqual([
          "read",
          "complete_subagent",
        ]);
        expect(Object.isFrozen(result.parentActiveToolNames)).toBe(true);
        expect(Object.isFrozen(result.effectiveToolNames)).toBe(true);
      }),
  );

  it.effect(
    "keeps every active name while deduplicating canonical providers",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            cwd: "/repo",
            activeToolNames: ["search", "lookup", "write"],
            toolProviders: [
              {
                name: "search",
                source: "local",
                path: "providers/search.ts",
              },
              {
                name: "lookup",
                source: "package",
                path: "/aliases/lookup.ts",
              },
              { name: "write", source: "builtin", path: "<builtin:write>" },
            ],
          },
          {
            metadata: new Map([
              ["/repo/providers/search.ts", file],
              ["/aliases/lookup.ts", file],
            ]),
            realPaths: new Map([
              ["/repo/providers/search.ts", "/canonical/provider.ts"],
              ["/aliases/lookup.ts", "/canonical/provider.ts"],
            ]),
          },
        );
        expect(result.effectiveToolNames).toEqual([
          "search",
          "lookup",
          "write",
          "complete_subagent",
        ]);
        expect(result.providerExtensions).toEqual(["/canonical/provider.ts"]);
      }),
  );

  it.effect("turns a provider stat failure into a diagnostic", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          cwd: "/repo",
          activeToolNames: ["missing_file"],
          toolProviders: [
            {
              name: "missing_file",
              source: "local",
              path: "/ext/missing.ts",
            },
          ],
        },
        {
          failures: new Map([
            [
              "stat",
              new Map([
                [
                  "/ext/missing.ts",
                  new FileSystemError({
                    operation: "stat",
                    path: "/ext/missing.ts",
                    message: "not found",
                  }),
                ],
              ]),
            ],
          ]),
        },
      );
      expect(result.effectiveToolNames).toEqual(["complete_subagent"]);
      expect(result.diagnostics).toEqual([
        expect.stringContaining("missing_file"),
      ]);
    }),
  );

  it.effect("omits every unsupported provider class with diagnostics", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          cwd: "/repo",
          activeToolNames: [
            "missing",
            "ambiguous",
            "sdk_bound",
            "synthetic",
            "directory",
            "uncanonicalizable",
          ],
          toolProviders: [
            { name: "ambiguous", source: "builtin", path: "<builtin:a>" },
            { name: "ambiguous", source: "local", path: "/ext/a.ts" },
            { name: "sdk_bound", source: "sdk", path: "<sdk:sdk_bound>" },
            { name: "synthetic", source: "local", path: "<inline>" },
            { name: "directory", source: "local", path: "/ext" },
            {
              name: "uncanonicalizable",
              source: "local",
              path: "/ext/broken.ts",
            },
          ],
        },
        {
          metadata: new Map<string, FileMetadata>([
            ["/ext", directory],
            ["/ext/broken.ts", file],
          ]),
          failures: new Map([
            [
              "realPath",
              new Map([
                [
                  "/ext/broken.ts",
                  new FileSystemError({
                    operation: "realPath",
                    path: "/ext/broken.ts",
                    message: "canonicalization denied",
                  }),
                ],
              ]),
            ],
          ]),
        },
      );
      expect(result.effectiveToolNames).toEqual(["complete_subagent"]);
      expect(result.providerExtensions).toEqual([]);
      expect(result.diagnostics).toHaveLength(6);
      for (const name of [
        "missing",
        "ambiguous",
        "sdk_bound",
        "synthetic",
        "directory",
        "uncanonicalizable",
      ]) {
        expect(result.diagnostics.join(" ")).toContain(name);
      }
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.parentActiveToolNames)).toBe(true);
      expect(Object.isFrozen(result.effectiveToolNames)).toBe(true);
      expect(Object.isFrozen(result.providerExtensions)).toBe(true);
      expect(Object.isFrozen(result.diagnostics)).toBe(true);
    }),
  );
});
