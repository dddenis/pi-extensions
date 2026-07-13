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

const definition = (
  name: string,
  options: {
    readonly description?: string;
    readonly model?: string;
    readonly thinking?: string;
    readonly tools?: string;
    readonly writer?: boolean;
    readonly body?: string;
  } = {},
): string => `---
name: ${name}
description: ${options.description ?? `The ${name} agent`}${
  options.model === undefined ? "" : `\nmodel: ${options.model}`
}${options.thinking === undefined ? "" : `\nthinking: ${options.thinking}`}${
  options.tools === undefined ? "" : `\ntools: ${options.tools}`
}${options.writer === undefined ? "" : `\nwriter: ${options.writer}`}
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
    "discovers only direct markdown regular files and freezes values",
    () => {
      const reviewerPath = path.join(definitionsDirectory, "reviewer.md");
      const testLayer = layer({
        exists: new Map([[definitionsDirectory, true]]),
        directories: new Map([
          [
            definitionsDirectory,
            [
              { name: "reviewer.md", kind: "file" },
              { name: "notes.txt", kind: "file" },
              { name: "nested.md", kind: "directory" },
              { name: "linked.md", kind: "other" },
            ],
          ],
        ]),
        contents: new Map([
          [
            reviewerPath,
            definition("reviewer", {
              model: "openai/gpt",
              thinking: "high",
              tools: "read, grep",
              writer: false,
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
              name: "reviewer",
              description: "The reviewer agent",
              model: "openai/gpt",
              thinking: "high",
              tools: ["read", "grep"],
              writer: false,
              rolePrompt: "Review carefully.",
              definitionPath: reviewerPath,
            },
          ],
          diagnostics: [],
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.definitions)).toBe(true);
        expect(Object.isFrozen(result.definitions[0])).toBe(true);
        expect(Object.isFrozen(result.definitions[0]?.tools)).toBe(true);
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect(
    "defaults omitted writer while preserving preflight inheritance fields",
    () => {
      const readerPath = path.join(definitionsDirectory, "reader.md");
      const testLayer = layer({
        exists: new Map([[definitionsDirectory, true]]),
        directories: new Map([
          [definitionsDirectory, [{ name: "reader.md", kind: "file" }]],
        ]),
        contents: new Map([[readerPath, definition("reader")]]),
      });

      return Effect.gen(function* () {
        const result = yield* discoverAgents;
        expect(result.definitions).toEqual([
          {
            name: "reader",
            description: "The reader agent",
            writer: true,
            rolePrompt: "Act as reader.",
            definitionPath: readerPath,
          },
        ]);
        expect(result.definitions[0]).not.toHaveProperty("model");
        expect(result.definitions[0]).not.toHaveProperty("thinking");
        expect(result.definitions[0]).not.toHaveProperty("tools");
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
        expect(result.definitions.map(({ name }) => name)).toEqual(["valid"]);
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
      expect(result.definitions.map(({ name }) => name)).toEqual(["unique"]);
      expect(result.diagnostics).toHaveLength(2);
      expect(result.diagnostics.map(({ agentName }) => agentName)).toEqual([
        "duplicate",
        "duplicate",
      ]);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect(
    "returns empty for a missing directory and diagnoses unreadable directories",
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
          definitions: [],
          diagnostics: [],
        });
        const probeFailure = yield* discoverAgents.pipe(
          Effect.provide(probeFailureLayer),
        );
        expect(probeFailure.catalog).toEqual({ _tag: "Unavailable" });
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
        expect(unreadable.definitions).toEqual([]);
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
      expect((yield* discoverAgents).definitions[0]?.name).toBe("first");
      const fileSystem = yield* FileSystemServiceTest;
      yield* fileSystem.setContent(filePath, definition("second"));
      expect((yield* discoverAgents).definitions[0]?.name).toBe("second");
      const state = yield* fileSystem.getState;
      expect(
        state.calls.filter(
          (call) => call.operation === "readTextFile" && call.path === filePath,
        ),
      ).toHaveLength(2);
    }).pipe(Effect.provide(testLayer));
  });
});
