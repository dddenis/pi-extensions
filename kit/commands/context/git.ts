import { $ } from "bun";
import { Effect, Schema } from "effect";

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()(
  "GitCommandError",
  { message: Schema.String },
) {}

export const formatGitFailure = (result: GitResult): string => {
  const output = [result.stdout, result.stderr]
    .filter((line) => line.length > 0)
    .join("\n");
  return output.length > 0 ? output : `git exited with code ${result.exitCode}`;
};

export const runGit = (args: ReadonlyArray<string>, cwd = process.cwd()) =>
  Effect.promise(async (): Promise<GitResult> => {
    const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  });

export const gitRefExists = (
  cloneUrl: string,
  ref: string,
): Effect.Effect<boolean, GitCommandError> =>
  Effect.gen(function* () {
    const result = yield* runGit(["ls-remote", "--exit-code", cloneUrl, ref]);

    if (result.exitCode === 0) {
      return true;
    }

    if (result.exitCode === 2) {
      return false;
    }

    return yield* new GitCommandError({
      message: `Failed to resolve ref ${ref} from ${cloneUrl}: ${formatGitFailure(result)}`,
    });
  });
