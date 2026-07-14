import { describe, it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { expect } from "vitest";
import {
  FileSystemServiceTest,
  type FileSystemServiceTestFailures,
} from "../../test/services/file-system";
import { FileSystemError, type FileMetadata } from "../services/file-system";
import type {
  AgentDefinitionDiagnostic,
  AgentDiscovery,
  DiscoveredAgent,
} from "./agents";
import {
  AgentDefinitionError,
  InvalidSubagentInput,
  InvalidWorkingDirectoryError,
  ToolProviderError,
  type SubagentError,
} from "./errors";
import {
  type ModelResolutionPort,
  type ParentSnapshot,
  preflight,
} from "./preflight";
import type { ThinkingLevel } from "./schemas";

const directoryMetadata = {
  kind: "directory" as const,
  mtimeMs: 0,
  mode: 0o755,
};
const fileMetadata = {
  kind: "file" as const,
  mtimeMs: 0,
  mode: 0o644,
};

const discoveredAgent = (
  name: string,
  options: {
    readonly model?: string;
    readonly thinking?: ThinkingLevel;
    readonly tools?: ReadonlyArray<string>;
  } = {},
): DiscoveredAgent =>
  Object.freeze({
    name,
    description: `${name} description`,
    rolePrompt: `${name} role`,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(options.tools === undefined
      ? {}
      : { tools: Object.freeze([...options.tools]) }),
    definitionPath: `/agent/subagents/agents/${name}.md`,
  });

const discovery = (
  definitions: ReadonlyArray<DiscoveredAgent>,
  diagnostics: ReadonlyArray<AgentDefinitionDiagnostic> = [],
  catalog: AgentDiscovery["catalog"]["_tag"] = "Complete",
): AgentDiscovery =>
  Object.freeze({
    catalog: Object.freeze({ _tag: catalog }),
    definitions: Object.freeze([...definitions]),
    diagnostics: Object.freeze([...diagnostics]),
  });

const builtin = (name: string) => ({
  name,
  source: "builtin",
  path: `<builtin:${name}>`,
});

const parent = (
  options: {
    readonly cwd?: string;
    readonly model?: string | false;
    readonly thinking?: ThinkingLevel;
    readonly tools?: ParentSnapshot["tools"];
  } = {},
): ParentSnapshot => ({
  cwd: options.cwd ?? "/repo",
  ...(options.model === false
    ? {}
    : { model: options.model ?? "openai/parent" }),
  thinking: options.thinking ?? "medium",
  tools: options.tools ?? [builtin("read"), builtin("grep")],
});

const models = (
  resolve: ModelResolutionPort["resolve"] = (pattern, thinking) =>
    Effect.succeed({ model: pattern, thinking }),
): ModelResolutionPort => ({ resolve });

const request = (
  tasks: ReadonlyArray<{
    readonly agent: string;
    readonly task: string;
    readonly cwd?: string;
  }>,
) => ({ tasks });

const run = (options: {
  readonly definitions: ReadonlyArray<DiscoveredAgent>;
  readonly diagnostics?: ReadonlyArray<AgentDefinitionDiagnostic>;
  readonly catalog?: AgentDiscovery["catalog"]["_tag"];
  readonly tasks?: ReadonlyArray<{
    readonly agent: string;
    readonly task: string;
    readonly cwd?: string;
  }>;
  readonly parent?: ParentSnapshot;
  readonly models?: ModelResolutionPort;
  readonly metadata?: ReadonlyMap<
    string,
    {
      readonly kind: "file" | "directory" | "other";
      readonly mtimeMs: number;
      readonly mode: number;
    }
  >;
  readonly realPaths?: ReadonlyMap<string, string>;
  readonly failures?: FileSystemServiceTestFailures;
}) =>
  preflight({
    request: request(
      options.tasks ??
        options.definitions.map((agent) => ({
          agent: agent.name,
          task: `Task for ${agent.name}`,
        })),
    ),
    discovery: discovery(
      options.definitions,
      options.diagnostics,
      options.catalog,
    ),
    parent: options.parent ?? parent(),
    models: options.models ?? models(),
  }).pipe(
    Effect.provide(
      FileSystemServiceTest.layer({
        metadata: options.metadata ?? new Map([["/repo", directoryMetadata]]),
        realPaths: options.realPaths,
        failures: options.failures,
      }),
    ),
  );

const expectFailureTag = <A>(
  either: Either.Either<A, SubagentError>,
  tag: SubagentError["_tag"],
): SubagentError => {
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isRight(either)) {
    throw new Error("Expected preflight to fail");
  }
  expect(either.left._tag).toBe(tag);
  return either.left;
};

describe("preflight working directories and agents", () => {
  it.effect(
    "resolves relative cwd against parent cwd and preserves absolute cwd",
    () => {
      const alpha = discoveredAgent("alpha", {
        tools: ["read"],
      });
      return Effect.gen(function* () {
        const result = yield* run({
          definitions: [alpha],
          tasks: [
            { agent: "alpha", task: "one", cwd: "packages/app" },
            { agent: "alpha", task: "two", cwd: "/external/project" },
          ],
          metadata: new Map([
            ["/repo/packages/app", directoryMetadata],
            ["/external/project", directoryMetadata],
          ]),
        });
        expect(result.map(({ cwd }) => cwd)).toEqual([
          "/repo/packages/app",
          "/external/project",
        ]);
      });
    },
  );

  it.effect("rejects a missing cwd or a path that is not a directory", () =>
    Effect.gen(function* () {
      const agent = discoveredAgent("alpha");
      const missing = yield* Effect.either(
        run({
          definitions: [agent],
          tasks: [{ agent: "alpha", task: "write", cwd: "missing" }],
          metadata: new Map(),
          failures: new Map([
            [
              "stat",
              new Map([
                [
                  "/repo/missing",
                  new FileSystemError({
                    operation: "stat",
                    path: "/repo/missing",
                    message: "not found",
                  }),
                ],
              ]),
            ],
          ]),
        }),
      );
      expectFailureTag(missing, "InvalidWorkingDirectoryError");

      const file = yield* Effect.either(
        run({
          definitions: [agent],
          tasks: [{ agent: "alpha", task: "write", cwd: "/repo/file" }],
          metadata: new Map([["/repo/file", fileMetadata]]),
        }),
      );
      const error = expectFailureTag(file, "InvalidWorkingDirectoryError");
      expect(error).toBeInstanceOf(InvalidWorkingDirectoryError);
    }),
  );

  it.effect(
    "distinguishes complete missing, unavailable, indeterminate, and named-invalid lookups",
    () =>
      Effect.gen(function* () {
        const missing = yield* Effect.either(
          run({
            definitions: [],
            tasks: [{ agent: "absent", task: "work" }],
          }),
        );
        expectFailureTag(missing, "InvalidSubagentInput");

        const unavailable = yield* Effect.either(
          run({
            definitions: [],
            catalog: "Unavailable",
            diagnostics: [
              {
                definitionPath: "/agent/subagents/agents",
                message: "permission denied",
              },
            ],
            tasks: [{ agent: "absent", task: "work" }],
          }),
        );
        const unavailableError = expectFailureTag(
          unavailable,
          "AgentDefinitionError",
        );
        expect(unavailableError).toBeInstanceOf(AgentDefinitionError);
        if (!(unavailableError instanceof AgentDefinitionError)) return;
        expect(unavailableError.reason).toBe("unavailable");
        expect(unavailableError.message).not.toContain(
          "No discovered agent has this name",
        );

        const indeterminate = yield* Effect.either(
          run({
            definitions: [],
            catalog: "Indeterminate",
            diagnostics: [
              {
                definitionPath: "/agent/subagents/agents/unreadable.md",
                message: "read denied",
              },
              {
                definitionPath: "/agent/subagents/agents/malformed.md",
                message: "invalid YAML",
              },
            ],
            tasks: [{ agent: "unknown", task: "work" }],
          }),
        );
        const indeterminateError = expectFailureTag(
          indeterminate,
          "AgentDefinitionError",
        );
        if (!(indeterminateError instanceof AgentDefinitionError)) return;
        expect(indeterminateError.reason).toBe("indeterminate");
        expect(indeterminateError.definitionPaths).toEqual([
          "/agent/subagents/agents/unreadable.md",
          "/agent/subagents/agents/malformed.md",
        ]);

        const malformed = yield* Effect.either(
          run({
            definitions: [],
            diagnostics: [
              {
                definitionPath: "/agent/subagents/agents/broken-a.md",
                agentName: "broken",
                message: "Invalid frontmatter",
              },
              {
                definitionPath: "/agent/subagents/agents/broken-b.md",
                agentName: "broken",
                message: "Duplicate agent name: broken",
              },
            ],
            tasks: [{ agent: "broken", task: "work" }],
          }),
        );
        const malformedError = expectFailureTag(
          malformed,
          "AgentDefinitionError",
        );
        if (!(malformedError instanceof AgentDefinitionError)) return;
        expect(malformedError.reason).toBe("invalid-definition");
        expect(malformedError.definitionPaths).toEqual([
          "/agent/subagents/agents/broken-a.md",
          "/agent/subagents/agents/broken-b.md",
        ]);
        expect(malformedError.diagnostics).toHaveLength(2);
      }),
  );

  it.effect(
    "runs a valid requested definition with unrelated diagnostics but rejects a related invalid neighbor",
    () =>
      Effect.gen(function* () {
        const valid = discoveredAgent("valid");
        const unrelated = yield* run({
          definitions: [valid],
          catalog: "Indeterminate",
          diagnostics: [
            {
              definitionPath: "/agent/subagents/agents/unknown.md",
              message: "cannot parse frontmatter",
            },
            {
              definitionPath: "/agent/subagents/agents/other.md",
              agentName: "other",
              message: "invalid definition",
            },
          ],
        });
        expect(unrelated[0]?.agent.name).toBe("valid");

        const related = yield* Effect.either(
          run({
            definitions: [valid],
            diagnostics: [
              {
                definitionPath: valid.definitionPath,
                agentName: "valid",
                message: "conflicting invalid definition",
              },
            ],
          }),
        );
        const relatedError = expectFailureTag(related, "AgentDefinitionError");
        if (!(relatedError instanceof AgentDefinitionError)) return;
        expect(relatedError.definitionPaths).toEqual([valid.definitionPath]);
      }),
  );
});

describe("preflight model resolution", () => {
  it.effect(
    "inherits parent model and thinking while honoring explicit thinking",
    () =>
      Effect.gen(function* () {
        const inherited = discoveredAgent("inherited", {
          tools: ["read"],
        });
        const explicitThinking = discoveredAgent("deep", {
          thinking: "high",
          tools: ["read"],
        });
        const result = yield* run({
          definitions: [inherited, explicitThinking],
          parent: parent({ model: "anthropic/parent", thinking: "low" }),
        });
        expect(
          result.map(({ agent }) => [agent.model, agent.thinking]),
        ).toEqual([
          ["anthropic/parent", "low"],
          ["anthropic/parent", "high"],
        ]);
      }),
  );

  it.effect(
    "resolves inherited models so explicit thinking is capability-adjusted",
    () => {
      const calls: Array<readonly [string, ThinkingLevel]> = [];
      const resolver = models((pattern, thinking) =>
        Effect.sync(() => {
          calls.push([pattern, thinking]);
          return { model: pattern, thinking: "off" as const };
        }),
      );
      return Effect.gen(function* () {
        const result = yield* run({
          definitions: [discoveredAgent("non-reasoning", { thinking: "high" })],
          parent: parent({ model: "openai/non-reasoning", thinking: "off" }),
          models: resolver,
        });
        expect(calls).toEqual([["openai/non-reasoning", "high"]]);
        expect(result[0]?.agent.thinking).toBe("off");
      });
    },
  );

  it.effect(
    "resolves explicit model patterns and uses canonical clamped output",
    () => {
      const calls: Array<readonly [string, ThinkingLevel]> = [];
      const resolver = models((pattern, thinking) =>
        Effect.sync(() => {
          calls.push([pattern, thinking]);
          return {
            model: "openai-codex/gpt-5.4",
            thinking: "medium" as const,
          };
        }),
      );
      return Effect.gen(function* () {
        const result = yield* run({
          definitions: [
            discoveredAgent("resolved", {
              model: "gpt-5.4",
              thinking: "max",
            }),
          ],
          parent: parent({ thinking: "low" }),
          models: resolver,
        });
        expect(calls).toEqual([["gpt-5.4", "max"]]);
        expect(result[0]?.agent.model).toBe("openai-codex/gpt-5.4");
        expect(result[0]?.agent.thinking).toBe("medium");
      });
    },
  );

  it.effect(
    "passes inherited thinking through successful warning-bearing resolution",
    () => {
      let warningObserved = false;
      const resolver = models((pattern, thinking) =>
        Effect.sync(() => {
          warningObserved = true;
          return { model: `canonical/${pattern}`, thinking };
        }),
      );
      return Effect.gen(function* () {
        const result = yield* run({
          definitions: [discoveredAgent("warned", { model: "match" })],
          parent: parent({ thinking: "xhigh" }),
          models: resolver,
        });
        expect(warningObserved).toBe(true);
        expect(result[0]?.agent).toMatchObject({
          model: "canonical/match",
          thinking: "xhigh",
        });
      });
    },
  );

  it.effect(
    "rejects omitted parent model only when inheritance is needed",
    () =>
      Effect.gen(function* () {
        const inherited = yield* Effect.either(
          run({
            definitions: [discoveredAgent("inherited")],
            parent: parent({ model: false }),
          }),
        );
        expectFailureTag(inherited, "InvalidSubagentInput");

        const explicit = yield* run({
          definitions: [
            discoveredAgent("explicit", { model: "anthropic/child" }),
          ],
          parent: parent({ model: false }),
        });
        expect(explicit[0]?.agent.model).toBe("anthropic/child");
      }),
  );

  it.effect("propagates resolver errors", () => {
    const resolverError = new InvalidSubagentInput({
      subject: "bad-pattern",
      field: "model",
      message: "Model resolution failed",
    });
    return Effect.gen(function* () {
      const result = yield* Effect.either(
        run({
          definitions: [discoveredAgent("broken", { model: "bad-*" })],
          models: models(() => Effect.fail(resolverError)),
        }),
      );
      const error = expectFailureTag(result, "InvalidSubagentInput");
      expect(error).toBe(resolverError);
    });
  });
});

describe("preflight uniform tool policy", () => {
  it.effect(
    "resolves one to three tasks regardless of mutation-capable tools",
    () => {
      const definitions = [
        discoveredAgent("alpha"),
        discoveredAgent("beta", { tools: ["bash"] }),
        discoveredAgent("gamma", { tools: ["read", "edit", "write"] }),
      ];
      return Effect.gen(function* () {
        const result = yield* run({
          definitions,
          parent: parent({
            tools: ["read", "bash", "edit", "write"].map(builtin),
          }),
        });
        expect(result.map(({ agent }) => agent.name)).toEqual([
          "alpha",
          "beta",
          "gamma",
        ]);
        expect(result.map(({ agent }) => agent.tools)).toEqual([
          undefined,
          ["bash"],
          ["read", "edit", "write"],
        ]);
        expect(result.every(({ agent }) => !("writer" in agent))).toBe(true);
      });
    },
  );
});

describe("preflight tool-provider provenance", () => {
  it.effect("loads a safe-name external override for alpha", () => {
    const provider = "/repo/extensions/read.ts";
    return Effect.gen(function* () {
      const result = yield* run({
        definitions: [discoveredAgent("alpha", { tools: ["read"] })],
        parent: parent({
          tools: [
            { name: "read", source: "extension", path: "extensions/read.ts" },
          ],
        }),
        metadata: new Map<string, FileMetadata>([
          ["/repo", directoryMetadata],
          [provider, fileMetadata],
        ]),
        realPaths: new Map([[provider, provider]]),
      });
      expect(result[0]?.agent.providerExtensions).toEqual([provider]);
    });
  });

  it.effect(
    "rejects missing, SDK, synthetic, and duplicate provider entries",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<ParentSnapshot["tools"]> = [
          [],
          [{ name: "custom", source: "sdk", path: "/sdk/custom.ts" }],
          [{ name: "custom", source: "extension", path: "<inline>" }],
          [
            { name: "custom", source: "builtin", path: "<builtin>" },
            { name: "custom", source: "extension", path: "/ext/custom.ts" },
          ],
        ];
        for (const tools of cases) {
          const result = yield* Effect.either(
            run({
              definitions: [discoveredAgent("beta", { tools: ["custom"] })],
              parent: parent({ tools }),
            }),
          );
          const error = expectFailureTag(result, "ToolProviderError");
          expect(error).toBeInstanceOf(ToolProviderError);
        }
      }),
  );

  it.effect(
    "requires external provider paths to be existing regular files",
    () =>
      Effect.gen(function* () {
        const provider = "/repo/provider.ts";
        for (const metadata of [
          new Map([["/repo", directoryMetadata]]),
          new Map([
            ["/repo", directoryMetadata],
            [provider, directoryMetadata],
          ]),
        ]) {
          const result = yield* Effect.either(
            run({
              definitions: [discoveredAgent("beta", { tools: ["custom"] })],
              parent: parent({
                tools: [
                  { name: "custom", source: "extension", path: "provider.ts" },
                ],
              }),
              metadata,
              failures: metadata.has(provider)
                ? undefined
                : new Map([
                    [
                      "stat",
                      new Map([
                        [
                          provider,
                          new FileSystemError({
                            operation: "stat",
                            path: provider,
                            message: "not found",
                          }),
                        ],
                      ]),
                    ],
                  ]),
            }),
          );
          expectFailureTag(result, "ToolProviderError");
        }
      }),
  );

  it.effect(
    "resolves against baseDir and deduplicates canonical paths in first-use order",
    () => {
      const first = "/extensions/first.ts";
      const alias = "/workspace/providers/alias.ts";
      const second = "/workspace/providers/second.ts";
      return Effect.gen(function* () {
        const result = yield* run({
          definitions: [
            discoveredAgent("gamma", { tools: ["first", "alias", "second"] }),
          ],
          parent: parent({
            tools: [
              { name: "first", source: "extension", path: first },
              {
                name: "alias",
                source: "extension",
                path: "alias.ts",
                baseDir: "/workspace/providers",
              },
              {
                name: "second",
                source: "extension",
                path: "second.ts",
                baseDir: "/workspace/providers",
              },
            ],
          }),
          metadata: new Map<string, FileMetadata>([
            ["/repo", directoryMetadata],
            [first, fileMetadata],
            [alias, fileMetadata],
            [second, fileMetadata],
          ]),
          realPaths: new Map([
            [first, "/canonical/shared.ts"],
            [alias, "/canonical/shared.ts"],
            [second, "/canonical/second.ts"],
          ]),
        });
        expect(result[0]?.agent.providerExtensions).toEqual([
          "/canonical/shared.ts",
          "/canonical/second.ts",
        ]);
      });
    },
  );

  it.effect("rejects reserved complete_subagent and subagent tool names", () =>
    Effect.gen(function* () {
      for (const reserved of ["complete_subagent", "subagent"]) {
        const result = yield* Effect.either(
          run({
            definitions: [discoveredAgent("beta", { tools: [reserved] })],
            parent: parent({ tools: [builtin(reserved)] }),
          }),
        );
        expectFailureTag(result, "ToolProviderError");
      }
    }),
  );
});

describe("preflight output", () => {
  it.effect(
    "preserves request order and deeply freezes copied execution values",
    () => {
      const mutableTools = ["read"];
      const mutableParentTools = [builtin("read")];
      const first = discoveredAgent("first", {
        tools: mutableTools,
      });
      const second = discoveredAgent("second", {
        tools: mutableTools,
      });
      return Effect.gen(function* () {
        const result = yield* run({
          definitions: [first, second],
          tasks: [
            { agent: "second", task: "second task" },
            { agent: "first", task: "first task" },
          ],
          parent: parent({ tools: mutableParentTools }),
        });
        expect(
          result.map(({ index, task, agent }) => [index, task, agent.name]),
        ).toEqual([
          [0, "second task", "second"],
          [1, "first task", "first"],
        ]);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result.every(Object.isFrozen)).toBe(true);
        expect(result.every(({ agent }) => Object.isFrozen(agent))).toBe(true);
        expect(result.every(({ agent }) => Object.isFrozen(agent.tools))).toBe(
          true,
        );
        expect(
          result.every(({ agent }) =>
            Object.isFrozen(agent.providerExtensions),
          ),
        ).toBe(true);
      });
    },
  );
});
