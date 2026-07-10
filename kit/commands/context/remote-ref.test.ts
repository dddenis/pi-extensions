import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { resolveRemoteRef } from "./remote-ref";
import { PACKAGE_CONTEXT_REPOS } from "./repositories";

const piRepo = PACKAGE_CONTEXT_REPOS.find((repo) => repo.name === "pi");
const effectRepo = PACKAGE_CONTEXT_REPOS.find((repo) => repo.name === "effect");

describe("resolveRemoteRef", () => {
  it.effect("uses the Effect tag convention directly", () => {
    if (!effectRepo) {
      throw new Error("effect repo definition missing");
    }

    return resolveRemoteRef(effectRepo, "3.21.3", (_cloneUrl, ref) =>
      Effect.succeed(ref === "effect@3.21.3"),
    ).pipe(Effect.map((ref) => expect(ref).toBe("effect@3.21.3")));
  });

  it.effect("tries Pi candidate refs until one exists", () => {
    if (!piRepo) {
      throw new Error("pi repo definition missing");
    }

    return resolveRemoteRef(piRepo, "1.2.3", (_cloneUrl, ref) =>
      Effect.succeed(ref === "pi-coding-agent@1.2.3"),
    ).pipe(Effect.map((ref) => expect(ref).toBe("pi-coding-agent@1.2.3")));
  });

  it.effect("fails clearly when no candidate ref exists", () => {
    if (!piRepo) {
      throw new Error("pi repo definition missing");
    }

    return resolveRemoteRef(piRepo, "1.2.3", () => Effect.succeed(false)).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toHaveProperty("_tag", "RemoteRefNotFoundError");
        expect(error.message).toContain("No matching ref for pi 1.2.3");
        expect(error.message).toContain(
          "@earendil-works/pi-coding-agent@1.2.3",
        );
        expect(error.message).toContain("pi-coding-agent@1.2.3");
      }),
    );
  });
});
