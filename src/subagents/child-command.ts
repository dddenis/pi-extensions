import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface ParentSnapshot {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
}

export interface ChildCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface CurrentProcessInfo {
  readonly execPath: string;
  readonly scriptPath?: string;
  readonly scriptExists: (path: string) => boolean;
}

const liveProcessInfo = (): CurrentProcessInfo => ({
  execPath: process.execPath,
  ...(process.argv[1] === undefined ? {} : { scriptPath: process.argv[1] }),
  scriptExists: existsSync,
});

const fixedArgs = (snapshot: ParentSnapshot): ReadonlyArray<string> => [
  "--mode",
  "text",
  "--print",
  "--no-session",
  "--model",
  snapshot.provider + "/" + snapshot.modelId,
  "--thinking",
  snapshot.thinkingLevel,
  "--tools",
  "read,bash,edit,write,grep,find,ls",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
];

export const buildChildCommand = (
  snapshot: ParentSnapshot,
  current: CurrentProcessInfo = liveProcessInfo(),
): ChildCommand => {
  const args = fixedArgs(snapshot);
  const script = current.scriptPath;
  const reusableScript =
    script !== undefined &&
    !script.startsWith("/$bunfs/root/") &&
    current.scriptExists(script);

  if (reusableScript) {
    return { command: current.execPath, args: [script, ...args] };
  }

  const executable = basename(current.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: current.execPath, args };
  }

  return { command: "pi", args };
};
