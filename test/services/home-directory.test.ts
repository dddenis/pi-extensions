import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { HomeDirectoryService } from "../../src/services/home-directory";
import { HomeDirectoryServiceTest } from "./home-directory";

describe("HomeDirectoryServiceTest", () => {
  it.effect("copies calls and snapshots", () =>
    Effect.gen(function* () {
      const homeDirectory = yield* HomeDirectoryService;
      const controls = yield* HomeDirectoryServiceTest;

      expect(yield* homeDirectory.get).toBe("/initial/home");
      const snapshot = yield* controls.getState;
      Object.assign(snapshot.calls[0] ?? {}, { mutated: true });
      Object.assign(snapshot, { homeDirectory: "/mutated/home" });

      expect(yield* controls.getState).toEqual({
        calls: [{}],
        homeDirectory: "/initial/home",
      });
    }).pipe(
      Effect.provide(
        HomeDirectoryServiceTest.layer({ homeDirectory: "/initial/home" }),
      ),
    ),
  );

  it.effect("resetCalls preserves the configured home directory", () =>
    Effect.gen(function* () {
      const homeDirectory = yield* HomeDirectoryService;
      const controls = yield* HomeDirectoryServiceTest;
      yield* homeDirectory.get;

      yield* controls.resetCalls;

      expect(yield* controls.getState).toEqual({
        calls: [],
        homeDirectory: "/initial/home",
      });
      expect(yield* homeDirectory.get).toBe("/initial/home");
    }).pipe(
      Effect.provide(
        HomeDirectoryServiceTest.layer({ homeDirectory: "/initial/home" }),
      ),
    ),
  );

  it.effect("reset restores the initial home directory", () =>
    Effect.gen(function* () {
      const homeDirectory = yield* HomeDirectoryService;
      const controls = yield* HomeDirectoryServiceTest;
      yield* controls.setHomeDirectory("/changed/home");
      yield* homeDirectory.get;

      yield* controls.reset;

      expect(yield* controls.getState).toEqual({
        calls: [],
        homeDirectory: "/initial/home",
      });
      expect(yield* homeDirectory.get).toBe("/initial/home");
    }).pipe(
      Effect.provide(
        HomeDirectoryServiceTest.layer({ homeDirectory: "/initial/home" }),
      ),
    ),
  );
});
