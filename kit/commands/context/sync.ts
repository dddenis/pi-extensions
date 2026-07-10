import { FileSystem, Path } from "@effect/platform";
import { Cause, Effect, Schema } from "effect";
import { gitRefExists } from "./git";
import {
  getDependencyVersion,
  MissingDependencyError,
  PackageManifestSchema,
} from "./package-manifest";
import { resolveRemoteRef } from "./remote-ref";
import { PACKAGE_CONTEXT_REPOS } from "./repositories";
import { syncSubtree } from "./subtree";

const readPackageManifest = (projectRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageJsonPath = path.join(projectRoot, "package.json");
    const content = yield* fs.readFileString(packageJsonPath);
    const parsed = JSON.parse(content) as unknown;
    return yield* Schema.decodeUnknown(PackageManifestSchema)(parsed);
  });

export const syncContextRepos = Effect.gen(function* () {
  const projectRoot = process.cwd();
  const manifest = yield* readPackageManifest(projectRoot);

  for (const repo of PACKAGE_CONTEXT_REPOS) {
    const cleanVersion = yield* Effect.try({
      try: () => getDependencyVersion(manifest, repo.packageName),
      catch: (cause) =>
        cause instanceof MissingDependencyError
          ? cause
          : new Cause.UnknownException(
              cause,
              `Failed to read dependency ${repo.packageName}`,
            ),
    });

    yield* Effect.logInfo(
      `Checking ${repo.name} for ${repo.packageName}@${cleanVersion}`,
    );
    const ref = yield* resolveRemoteRef(repo, cleanVersion, gitRefExists);
    yield* syncSubtree(repo, ref, projectRoot);
  }

  yield* Effect.logInfo("Context sync complete");
});
