import { homedir } from "node:os";
import { Command } from "@effect/cli";
import { Path } from "@effect/platform";
import { Effect } from "effect";
import {
  linkGlobal,
  resolveAgentDirectory,
  unlinkGlobal,
  type GlobalLinkResult,
} from "./global-link";

const formatResult = (result: GlobalLinkResult): string => {
  switch (result._tag) {
    case "Linked":
      return `Linked ${result.destination} -> ${result.target}. Run /reload or restart Pi.`;
    case "AlreadyLinked":
      return `${result.destination} already links to ${result.target}. Run /reload or restart Pi.`;
    case "Unlinked":
      return `Removed ${result.destination}, which linked to ${result.target}. Restart or reload Pi if it is running.`;
    case "AlreadyAbsent":
      return `${result.destination} is already absent; nothing to remove.`;
  }
};

const runGlobalLink = (operation: typeof linkGlobal | typeof unlinkGlobal) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const agentDirectory = resolveAgentDirectory(path, process.env, homedir());
    const result = yield* operation({
      projectRoot: process.cwd(),
      agentDirectory,
    });
    yield* Effect.logInfo(formatResult(result));
  });

const linkGlobalCommand = Command.make("link-global", {}, () =>
  runGlobalLink(linkGlobal),
);

const unlinkGlobalCommand = Command.make("unlink-global", {}, () =>
  runGlobalLink(unlinkGlobal),
);

export const piCommand = Command.make("pi", {}).pipe(
  Command.withSubcommands([linkGlobalCommand, unlinkGlobalCommand]),
);
