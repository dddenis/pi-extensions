import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { gitRefExists } from "./git";

describe("gitRefExists", () => {
  it.effect("fails with a tagged error when git cannot query the remote", () =>
    gitRefExists("/definitely/missing/context-repo.git", "v1.0.0").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toHaveProperty("_tag", "GitCommandError");
        expect(error.message).toContain("Failed to resolve ref v1.0.0");
      }),
    ),
  );
});
