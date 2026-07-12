import { homedir } from "node:os";
import { Context, Effect, Layer } from "effect";

export interface HomeDirectoryService {
  readonly get: Effect.Effect<string>;
}

const HomeDirectoryServiceTag = Context.GenericTag<HomeDirectoryService>(
  "pi-extensions/HomeDirectoryService",
);

export const HomeDirectoryService = Object.assign(HomeDirectoryServiceTag, {
  Live: Layer.succeed(HomeDirectoryServiceTag, {
    get: Effect.sync(homedir),
  } satisfies HomeDirectoryService),
});
