import { FileSystem, Path } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import type { PackageContextRepo } from "./repositories";
import { syncSubtree } from "./subtree";

const repo: PackageContextRepo = {
  name: "test",
  packageName: "test-package",
  repoPath: ".context/test",
  cloneUrl: "/definitely/missing/context-repo.git",
  refsForVersion: (version) => [version],
};

const makeProjectRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped();
});

describe("syncSubtree", () => {
  it.effect("fails with a tagged error when adding the subtree fails", () =>
    Effect.gen(function* () {
      const projectRoot = yield* makeProjectRoot;
      const error = yield* syncSubtree(repo, "v1.0.0", projectRoot).pipe(
        Effect.flip,
      );

      expect(error).toHaveProperty("_tag", "GitCommandError");
      expect(error.message).toContain("Failed to add test subtree");
    }).pipe(Effect.scoped, Effect.provide(BunContext.layer)),
  );

  it.effect("fails with a tagged error when pulling the subtree fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectRoot = yield* makeProjectRoot;
      yield* fs.makeDirectory(path.join(projectRoot, repo.repoPath), {
        recursive: true,
      });

      const error = yield* syncSubtree(repo, "v1.0.0", projectRoot).pipe(
        Effect.flip,
      );

      expect(error).toHaveProperty("_tag", "GitCommandError");
      expect(error.message).toContain("Failed to pull test subtree");
    }).pipe(Effect.scoped, Effect.provide(BunContext.layer)),
  );
});
