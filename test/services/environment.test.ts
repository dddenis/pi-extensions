import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { EnvironmentService } from "../../src/services/environment";
import { EnvironmentServiceTest } from "./environment";

describe("EnvironmentServiceTest", () => {
  it.effect("copies calls and snapshots", () =>
    Effect.gen(function* () {
      const environment = yield* EnvironmentService;
      const controls = yield* EnvironmentServiceTest;

      expect(yield* environment.get("FIRST")).toBe("one");
      const snapshot = yield* controls.getState;
      Object.assign(snapshot.calls[0] ?? {}, { name: "MUTATED" });
      Object.assign(snapshot.values, { FIRST: "mutated", EXTRA: "value" });

      expect(yield* controls.getState).toEqual({
        calls: [{ name: "FIRST" }],
        values: { FIRST: "one" },
      });
    }).pipe(
      Effect.provide(
        EnvironmentServiceTest.layer({ values: { FIRST: "one" } }),
      ),
    ),
  );

  it.effect("resetCalls preserves configured values", () =>
    Effect.gen(function* () {
      const environment = yield* EnvironmentService;
      const controls = yield* EnvironmentServiceTest;
      yield* environment.get("FIRST");

      yield* controls.resetCalls;

      expect(yield* controls.getState).toEqual({
        calls: [],
        values: { FIRST: "one" },
      });
      expect(yield* environment.get("FIRST")).toBe("one");
    }).pipe(
      Effect.provide(
        EnvironmentServiceTest.layer({ values: { FIRST: "one" } }),
      ),
    ),
  );

  it.effect("reset restores the initial values", () =>
    Effect.gen(function* () {
      const environment = yield* EnvironmentService;
      const controls = yield* EnvironmentServiceTest;
      yield* controls.setValues({ FIRST: "changed", SECOND: "two" });
      yield* environment.get("SECOND");

      yield* controls.reset;

      expect(yield* controls.getState).toEqual({
        calls: [],
        values: { FIRST: "one" },
      });
      expect(yield* environment.get("FIRST")).toBe("one");
      expect(yield* environment.get("SECOND")).toBeUndefined();
    }).pipe(
      Effect.provide(
        EnvironmentServiceTest.layer({ values: { FIRST: "one" } }),
      ),
    ),
  );
});
