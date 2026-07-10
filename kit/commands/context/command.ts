import { Command } from "@effect/cli";
import { syncContextRepos } from "./sync";

const syncCommand = Command.make("sync", {}, () => syncContextRepos);

export const contextCommand = Command.make("context", {}).pipe(
  Command.withSubcommands([syncCommand]),
);
