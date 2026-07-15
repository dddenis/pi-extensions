import { statSync } from "node:fs";
import path from "node:path";
import type { ResolvedTask } from "./preflight";
import type { RunArtifacts } from "./schemas";

export interface ChildInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ChildCommandRuntime {
  readonly execPath: string;
  readonly argv: ReadonlyArray<string>;
  readonly isFile: (candidate: string) => boolean;
}

export interface ChildCommandInput {
  readonly task: ResolvedTask;
  readonly artifacts: RunArtifacts;
  readonly parentEnv: Readonly<Record<string, string>>;
  readonly completionEntrypoint: string;
}

const liveRuntime = (): ChildCommandRuntime => ({
  execPath: process.execPath,
  argv: [...process.argv],
  isFile: (candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
});

const genericExecutableNames: ReadonlySet<string> = new Set([
  "bun",
  "bun.exe",
  "node",
  "node.exe",
]);

export interface ChildExecutableSelection {
  readonly command: string;
  readonly prefix: ReadonlyArray<string>;
}

export type ChildExecutableSelector = () => ChildExecutableSelection;

const selectPiCommand = (
  runtime: ChildCommandRuntime,
): ChildExecutableSelection => {
  const executableName = path.basename(runtime.execPath).toLowerCase();
  const generic = genericExecutableNames.has(executableName);
  if (!generic) return { command: runtime.execPath, prefix: [] };

  const currentScript = runtime.argv[1];
  return currentScript !== undefined && runtime.isFile(currentScript)
    ? { command: runtime.execPath, prefix: [path.resolve(currentScript)] }
    : { command: "pi", prefix: [] };
};

export const makeChildExecutableSelector =
  (runtime: ChildCommandRuntime): ChildExecutableSelector =>
  () =>
    selectPiCommand(runtime);

const liveExecutableSelector: ChildExecutableSelector = () =>
  selectPiCommand(liveRuntime());

const canonicalExtensions = (
  completionEntrypoint: string,
  providerExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const result: Array<string> = [];
  for (const extensionPath of [completionEntrypoint, ...providerExtensions]) {
    const canonicalPath = path.resolve(extensionPath);
    if (seen.has(canonicalPath)) continue;
    seen.add(canonicalPath);
    result.push(canonicalPath);
  }
  return result;
};

export const buildChildInvocation = (
  input: ChildCommandInput,
  selectExecutable: ChildExecutableSelector = liveExecutableSelector,
): ChildInvocation => {
  const pi = selectExecutable();
  const extensions = canonicalExtensions(
    input.completionEntrypoint,
    input.task.toolInheritance.providerExtensions,
  );
  const extensionArgs = extensions.flatMap((extensionPath) => [
    "--extension",
    extensionPath,
  ]);
  const toolArgs = [
    "--tools",
    input.task.toolInheritance.effectiveToolNames.join(","),
  ];

  return Object.freeze({
    command: pi.command,
    args: Object.freeze([
      ...pi.prefix,
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-extensions",
      ...extensionArgs,
      "--model",
      input.task.agent.model,
      "--thinking",
      input.task.agent.thinking,
      ...toolArgs,
      "--append-system-prompt",
      input.artifacts.systemPromptPath,
      `@${input.artifacts.taskPath}`,
    ]),
    cwd: input.task.cwd,
    env: Object.freeze({
      ...input.parentEnv,
      PI_SUBAGENT_CHILD: "1",
    }),
  });
};
