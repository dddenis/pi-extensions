import { FileSystem, Path } from "@effect/platform";
import { Effect } from "effect";
import { formatGitFailure, GitCommandError, runGit } from "./git";
import type { PackageContextRepo } from "./repositories";

const addSubtree = (
  repo: PackageContextRepo,
  ref: string,
  projectRoot: string,
) =>
  Effect.gen(function* () {
    const result = yield* runGit(
      [
        "subtree",
        "add",
        `--prefix=${repo.repoPath}`,
        repo.cloneUrl,
        ref,
        "--squash",
        "-m",
        `chore(context): add ${repo.name} subtree at ${ref}`,
      ],
      projectRoot,
    );

    if (result.exitCode !== 0) {
      return yield* new GitCommandError({
        message: `Failed to add ${repo.name} subtree: ${formatGitFailure(result)}`,
      });
    }
  });

const pullSubtree = (
  repo: PackageContextRepo,
  ref: string,
  projectRoot: string,
) =>
  Effect.gen(function* () {
    const result = yield* runGit(
      [
        "subtree",
        "pull",
        `--prefix=${repo.repoPath}`,
        repo.cloneUrl,
        ref,
        "--squash",
        "-m",
        `chore(context): sync ${repo.name} subtree to ${ref}`,
      ],
      projectRoot,
    );

    if (result.exitCode !== 0) {
      return yield* new GitCommandError({
        message: `Failed to pull ${repo.name} subtree: ${formatGitFailure(result)}`,
      });
    }
  });

export const syncSubtree = (
  repo: PackageContextRepo,
  ref: string,
  projectRoot = process.cwd(),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const repoFullPath = path.join(projectRoot, repo.repoPath);
    const legacyGitPath = path.join(repoFullPath, ".git");

    if (yield* fs.exists(legacyGitPath)) {
      yield* Effect.logInfo(
        `Removing legacy clone at ${repo.repoPath} before adding subtree`,
      );
      yield* fs.remove(repoFullPath, { recursive: true });
    }

    if (yield* fs.exists(repoFullPath)) {
      yield* Effect.logInfo(`Pulling ${repo.name} subtree ref ${ref}`);
      yield* pullSubtree(repo, ref, projectRoot);
      return;
    }

    yield* Effect.logInfo(`Adding ${repo.name} subtree ref ${ref}`);
    yield* addSubtree(repo, ref, projectRoot);
  });
