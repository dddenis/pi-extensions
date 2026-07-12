import path from "node:path";
import { Effect } from "effect";
import { EnvironmentService } from "../services/environment";
import { HomeDirectoryService } from "../services/home-directory";

export interface PathApi {
  readonly sep: string;
  readonly join: (...parts: ReadonlyArray<string>) => string;
  readonly resolve: (...parts: ReadonlyArray<string>) => string;
}

export const resolveAgentDirectory = (
  pathApi: PathApi,
  configuredDirectory: string | undefined,
  homeDirectory: string,
): string => {
  const configured =
    configuredDirectory || pathApi.join(homeDirectory, ".pi", "agent");
  const expanded =
    configured === "~"
      ? homeDirectory
      : configured.startsWith("~/") || configured.startsWith(`~${pathApi.sep}`)
        ? pathApi.join(homeDirectory, configured.slice(2))
        : configured;
  return pathApi.resolve(expanded);
};

export const resolveAgentDirectoryEffect = Effect.gen(function* () {
  const environment = yield* EnvironmentService;
  const homeDirectory = yield* HomeDirectoryService;
  return resolveAgentDirectory(
    path,
    yield* environment.get("PI_CODING_AGENT_DIR"),
    yield* homeDirectory.get,
  );
});
