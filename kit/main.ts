import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { contextCommand } from "./commands/context/command";
import { piCommand } from "./commands/pi/command";

const kitCommand = Command.make("kit", {}).pipe(
  Command.withSubcommands([contextCommand, piCommand]),
);

const cli = Command.run(kitCommand, {
  name: "kit",
  version: "0.1.0",
});

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
);
