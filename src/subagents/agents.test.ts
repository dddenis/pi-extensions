import path from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { EnvironmentServiceTest } from "../../test/services/environment";
import { FileSystemServiceTest } from "../../test/services/file-system";
import { HomeDirectoryServiceTest } from "../../test/services/home-directory";
import { FileSystemError } from "../services/file-system";
import { discoverAgents } from "./agents";

const agentDirectory = "/agent";
const definitionsDirectory = path.join(agentDirectory, "subagents", "agents");
const GENERAL_AGENT_ROLE_PROMPT = `You are a general-purpose subagent. Complete exactly the delegated task using
available tools.

Treat the task's supplied scope, paths, constraints, acceptance criteria,
validation requirements, and output contract as authoritative. Inspect evidence
rather than guessing. Make only changes required by the task, and do not broaden
scope or make unapproved product or architecture decisions.

If required information is missing, report NEEDS_CONTEXT. If the task cannot be
completed, report BLOCKED. Use DONE_WITH_CONCERNS only when the requested work is
complete but material uncertainty remains. When the task requires a durable
report, write it to the supplied absolute path and return that path through
structured completion.`;

const definition = (
  name: string,
  options: {
    readonly description?: string;
    readonly model?: string;
    readonly thinking?: string;
    readonly body?: string;
  } = {},
): string => `---
name: ${name}
description: ${options.description ?? `The ${name} agent`}${
  options.model === undefined ? "" : `\nmodel: ${options.model}`
}${options.thinking === undefined ? "" : `\nthinking: ${options.thinking}`}
---
${options.body ?? `Act as ${name}.`}`;

const layer = (config: Parameters<typeof FileSystemServiceTest.layer>[0]) =>
  Layer.mergeAll(
    EnvironmentServiceTest.layer({
      values: { PI_CODING_AGENT_DIR: agentDirectory },
    }),
    HomeDirectoryServiceTest.layer({ homeDirectory: "/home/me" }),
    FileSystemServiceTest.layer(config),
  );

describe("discoverAgents", () => {
  it.effect(
    "always exposes builtin general when global discovery is missing",
    () =>
      Effect.gen(function* () {
        const result = yield* discoverAgents;
        expect(result.definitions).toEqual([
          {
            name: "general",
            description: "General-purpose isolated task executor",
            rolePrompt: GENERAL_AGENT_ROLE_PROMPT,
            source: "builtin",
          },
        ]);
        expect(result.catalog).toEqual({ _tag: "Complete" });
      }).pipe(
        Effect.provide(
          layer({ exists: new Map([[definitionsDirectory, false]]) }),
        ),
      ),
  );

  it.effect("lets one valid global general shadow the builtin", () => {
    const definitionPath = path.join(definitionsDirectory, "general.md");
    return Effect.gen(function* () {
      const result = yield* discoverAgents;
      expect(result.definitions[0]).toEqual({
        name: "general",
        description: "Customized general",
        model: "openai/custom",
        rolePrompt: "Use the approved custom role.",
        source: "global",
        definitionPath,
      });
    }).pipe(
      Effect.provide(
        layer({
          exists: new Map([[definitionsDirectory, true]]),
          directories: new Map([
            [definitionsDirectory, [{ name: "general.md", kind: "file" }]],
          ]),
          contents: new Map([
            [
              definitionPath,
              definition("general", {
                description: "Customized general",
                model: "openai/custom",
                body: "Use the approved custom role.",
              }),
            ],
          ]),
        }),
      ),
    );
  });

  it.effect(
    "retains builtin general for malformed or duplicate globals",
    () => {
      const malformed = path.join(definitionsDirectory, "malformed.md");
      const first = path.join(definitionsDirectory, "first.md");
      const second = path.join(definitionsDirectory, "second.md");
      return Effect.gen(function* () {
        const result = yield* discoverAgents;
        expect(result.definitions[0]).toMatchObject({
          name: "general",
          source: "builtin",
        });
        expect(result.diagnostics.map(({ agentName }) => agentName)).toEqual([
          "general",
          "general",
          "general",
        ]);
      }).pipe(
        Effect.provide(
          layer({
            exists: new Map([[definitionsDirectory, true]]),
            directories: new Map([
              [
                definitionsDirectory,
                [malformed, first, second].map((filePath) => ({
                  name: path.basename(filePath),
                  kind: "file" as const,
                })),
              ],
            ]),
            contents: new Map([
              [
                malformed,
                "---\nname: general\ndescription: Legacy\ntools: read\n---\nLegacy role.",
              ],
              [first, definition("general")],
              [second, definition("general")],
            ]),
          }),
        ),
      );
    },
  );

  it.effect(
    "keeps builtin when a valid general has an invalid namesake",
    () => {
      const valid = path.join(definitionsDirectory, "valid-general.md");
      const invalid = path.join(definitionsDirectory, "invalid-general.md");
      return Effect.gen(function* () {
        const result = yield* discoverAgents;
        expect(result.definitions[0]).toMatchObject({
          name: "general",
          source: "builtin",
        });
        expect(result.diagnostics).toEqual([
          {
            definitionPath: invalid,
            agentName: "general",
            message: expect.stringContaining("tools"),
          },
        ]);
      }).pipe(
        Effect.provide(
          layer({
            exists: new Map([[definitionsDirectory, true]]),
            directories: new Map([
              [
                definitionsDirectory,
                [valid, invalid].map((filePath) => ({
                  name: path.basename(filePath),
                  kind: "file" as const,
                })),
              ],
            ]),
            contents: new Map([
              [valid, definition("general")],
              [
                invalid,
                "---\nname: general\ndescription: Invalid namesake\ntools: read\n---\nInvalid role.",
              ],
            ]),
          }),
        ),
      );
    },
  );

  it.effect(
    "discovers only direct markdown regular files and freezes values",
    () => {
      const alphaPath = path.join(definitionsDirectory, "alpha.md");
      const testLayer = layer({
        exists: new Map([[definitionsDirectory, true]]),
        directories: new Map([
          [
            definitionsDirectory,
            [
              { name: "alpha.md", kind: "file" },
              { name: "notes.txt", kind: "file" },
              { name: "nested.md", kind: "directory" },
              { name: "linked.md", kind: "other" },
            ],
          ],
        ]),
        contents: new Map([
          [
            alphaPath,
            definition("alpha", {
              model: "openai/gpt",
              thinking: "high",
              body: "Review carefully.",
            }),
          ],
        ]),
      });

      return Effect.gen(function* () {
        const result = yield* discoverAgents;
        expect(result).toEqual({
          catalog: { _tag: "Complete" },
          definitions: [
            {
              name: "general",
              description: "General-purpose isolated task executor",
              rolePrompt: GENERAL_AGENT_ROLE_PROMPT,
              source: "builtin",
            },
            {
              name: "alpha",
              description: "The alpha agent",
              model: "openai/gpt",
              thinking: "high",
              rolePrompt: "Review carefully.",
              source: "global",
              definitionPath: alphaPath,
            },
          ],
          diagnostics: [],
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.definitions)).toBe(true);
        expect(Object.isFrozen(result.definitions[0])).toBe(true);
        expect(result.definitions.every((agent) => !("tools" in agent))).toBe(
          true,
        );
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect(
    "diagnoses removed writer frontmatter without hiding a valid neighbor",
    () => {
      const alphaPath = path.join(definitionsDirectory, "alpha.md");
      const legacyPath = path.join(definitionsDirectory, "legacy.md");
      const testLayer = layer({
        exists: new Map([[definitionsDirectory, true]]),
        directories: new Map([
          [
            definitionsDirectory,
            [alphaPath, legacyPath].map((filePath) => ({
              name: path.basename(filePath),
              kind: "file" as const,
            })),
          ],
        ]),
        contents: new Map([
          [alphaPath, definition("alpha")],
          [
            legacyPath,
            "---\nname: legacy\ndescription: Legacy definition\nwriter: false\n---\nHandle the task.",
          ],
        ]),
      });

      return Effect.gen(function* () {
        const result = yield* discoverAgents;
        expect(result.definitions.map(({ name }) => name)).toEqual([
          "general",
          "alpha",
        ]);
        expect(result.definitions.every((agent) => !("writer" in agent))).toBe(
          true,
        );
        expect(result.diagnostics).toEqual([
          {
            definitionPath: legacyPath,
            agentName: "legacy",
            message: expect.stringContaining("writer"),
          },
        ]);
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect(
    "diagnoses malformed definitions without blocking a valid neighbor",
    () => {
      const paths = {
        yaml: path.join(definitionsDirectory, "bad-yaml.md"),
        schema: path.join(definitionsDirectory, "bad-schema.md"),
        body: path.join(definitionsDirectory, "empty-body.md"),
        valid: path.join(definitionsDirectory, "valid.md"),
      };
      const testLayer = layer({
        exists: new Map([[definitionsDirectory, true]]),
        directories: new Map([
          [
            definitionsDirectory,
            Object.values(paths).map((filePath) => ({
              name: path.basename(filePath),
              kind: "file" as const,
            })),
          ],
        ]),
        contents: new Map([
          [paths.yaml, "---\nname: [\n---\nbad"],
          [paths.schema, "---\nname: invalid\n---\nbody"],
          [paths.body, definition("empty", { body: "   \n" })],
          [paths.valid, definition("valid")],
        ]),
      });

      return Effect.gen(function* () {
        const result = yield* discoverAgents;
        expect(result.catalog).toEqual({ _tag: "Indeterminate" });
        expect(result.definitions.map(({ name }) => name)).toEqual([
          "general",
          "valid",
        ]);
        expect(result.diagnostics).toHaveLength(3);
        expect(
          result.diagnostics.map(({ definitionPath }) => definitionPath),
        ).toEqual([paths.yaml, paths.schema, paths.body]);
        expect(result.diagnostics.map(({ agentName }) => agentName)).toEqual([
          undefined,
          "invalid",
          "empty",
        ]);
        expect(
          result.diagnostics.every(({ message }) => message.length > 0),
        ).toBe(true);
        expect(Object.isFrozen(result.diagnostics)).toBe(true);
        expect(result.diagnostics.every(Object.isFrozen)).toBe(true);
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect("excludes every definition sharing a duplicate name", () => {
    const first = path.join(definitionsDirectory, "first.md");
    const second = path.join(definitionsDirectory, "second.md");
    const unique = path.join(definitionsDirectory, "unique.md");
    const testLayer = layer({
      exists: new Map([[definitionsDirectory, true]]),
      directories: new Map([
        [
          definitionsDirectory,
          [first, second, unique].map((filePath) => ({
            name: path.basename(filePath),
            kind: "file" as const,
          })),
        ],
      ]),
      contents: new Map([
        [first, definition("duplicate")],
        [second, definition("duplicate")],
        [unique, definition("unique")],
      ]),
    });

    return Effect.gen(function* () {
      const result = yield* discoverAgents;
      expect(result.definitions.map(({ name }) => name)).toEqual([
        "general",
        "unique",
      ]);
      expect(result.diagnostics).toHaveLength(2);
      expect(result.diagnostics.map(({ agentName }) => agentName)).toEqual([
        "duplicate",
        "duplicate",
      ]);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect(
    "returns builtin general for missing or unreadable directories",
    () => {
      const missingLayer = layer({
        exists: new Map([[definitionsDirectory, false]]),
      });
      const probeFailureLayer = layer({
        failures: new Map([
          [
            "exists",
            new Map([
              [
                definitionsDirectory,
                new FileSystemError({
                  operation: "exists",
                  path: definitionsDirectory,
                  message: "probe failed",
                }),
              ],
            ]),
          ],
        ]),
      });
      const unreadableLayer = layer({
        exists: new Map([[definitionsDirectory, true]]),
        failures: new Map([
          [
            "readDirectory",
            new Map([
              [
                definitionsDirectory,
                new FileSystemError({
                  operation: "readDirectory",
                  path: definitionsDirectory,
                  message: "permission denied",
                }),
              ],
            ]),
          ],
        ]),
      });

      return Effect.gen(function* () {
        expect(
          yield* discoverAgents.pipe(Effect.provide(missingLayer)),
        ).toEqual({
          catalog: { _tag: "Complete" },
          definitions: [
            expect.objectContaining({ name: "general", source: "builtin" }),
          ],
          diagnostics: [],
        });
        const probeFailure = yield* discoverAgents.pipe(
          Effect.provide(probeFailureLayer),
        );
        expect(probeFailure.catalog).toEqual({ _tag: "Unavailable" });
        expect(probeFailure.definitions).toEqual([
          expect.objectContaining({ name: "general", source: "builtin" }),
        ]);
        expect(probeFailure.diagnostics).toEqual([
          {
            definitionPath: definitionsDirectory,
            message: "probe failed",
          },
        ]);

        const unreadable = yield* discoverAgents.pipe(
          Effect.provide(unreadableLayer),
        );
        expect(unreadable.catalog).toEqual({ _tag: "Unavailable" });
        expect(unreadable.definitions).toEqual([
          expect.objectContaining({ name: "general", source: "builtin" }),
        ]);
        expect(unreadable.diagnostics).toEqual([
          {
            definitionPath: definitionsDirectory,
            message: "permission denied",
          },
        ]);
      });
    },
  );

  it.effect("rereads definitions on every call", () => {
    const filePath = path.join(definitionsDirectory, "dynamic.md");
    const testLayer = layer({
      exists: new Map([[definitionsDirectory, true]]),
      directories: new Map([
        [definitionsDirectory, [{ name: "dynamic.md", kind: "file" }]],
      ]),
      contents: new Map([[filePath, definition("first")]]),
    });

    return Effect.gen(function* () {
      expect(
        (yield* discoverAgents).definitions.map(({ name }) => name),
      ).toEqual(["general", "first"]);
      const fileSystem = yield* FileSystemServiceTest;
      yield* fileSystem.setContent(filePath, definition("second"));
      expect(
        (yield* discoverAgents).definitions.map(({ name }) => name),
      ).toEqual(["general", "second"]);
      const state = yield* fileSystem.getState;
      expect(
        state.calls.filter(
          (call) => call.operation === "readTextFile" && call.path === filePath,
        ),
      ).toHaveLength(2);
    }).pipe(Effect.provide(testLayer));
  });
});
