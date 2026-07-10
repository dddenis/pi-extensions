import { Effect, Schema } from "effect";
import type { PackageContextRepo } from "./repositories";

export class RemoteRefNotFoundError extends Schema.TaggedError<RemoteRefNotFoundError>()(
  "RemoteRefNotFoundError",
  {
    repoName: Schema.String,
    cleanVersion: Schema.String,
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No matching ref for ${this.repoName} ${this.cleanVersion}. Tried: ${this.candidates.join(", ")}`;
  }
}

export type RemoteRefExists<E> = (
  cloneUrl: string,
  ref: string,
) => Effect.Effect<boolean, E>;

export const resolveRemoteRef = <E>(
  repo: PackageContextRepo,
  cleanVersion: string,
  refExists: RemoteRefExists<E>,
): Effect.Effect<string, E | RemoteRefNotFoundError> =>
  Effect.gen(function* () {
    const candidates = repo.refsForVersion(cleanVersion);

    for (const candidate of candidates) {
      const exists = yield* refExists(repo.cloneUrl, candidate);
      if (exists) {
        return candidate;
      }
    }

    return yield* new RemoteRefNotFoundError({
      repoName: repo.name,
      cleanVersion,
      candidates,
    });
  });
