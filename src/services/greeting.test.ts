import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { expect } from "vitest";
import { GreetingServiceTest } from "../../test/services";
import { GreetingService, greet } from "./greeting";

describe("GreetingService", () => {
  it.effect("greets through the live service", () =>
    greet("Pi").pipe(
      Effect.provide(GreetingService.Live),
      Effect.map((message) => expect(message).toBe("Hello, Pi!")),
    ),
  );

  it.effect("uses a dual-tag test layer that records calls", () =>
    Effect.gen(function* () {
      const greetingTest = yield* GreetingServiceTest;
      yield* greetingTest.setResponse("Test hello, {name}!");

      const message = yield* greet("Agent");
      const state = yield* greetingTest.getState;

      expect(message).toBe("Test hello, Agent!");
      expect(state.calls).toEqual([{ name: "Agent" }]);
    }).pipe(Effect.provide(GreetingServiceTest.layer)),
  );

  it.effect("returns call snapshots isolated from internal state", () =>
    Effect.gen(function* () {
      const greetingTest = yield* GreetingServiceTest;
      yield* greetingTest.setResponse("Hello, {name}!");
      yield* greet("Original");

      const snapshot = yield* greetingTest.getState;
      snapshot.calls.forEach((call) =>
        Object.assign(call, { name: "Mutated" }),
      );
      const nextState = yield* greetingTest.getState;

      expect(nextState.calls).toEqual([{ name: "Original" }]);
    }).pipe(Effect.provide(GreetingServiceTest.layer)),
  );

  it.effect("resetCalls clears recorded calls without clearing response", () =>
    Effect.gen(function* () {
      const greetingTest = yield* GreetingServiceTest;
      yield* greetingTest.setResponse("Again, {name}!");
      yield* greet("First");
      yield* greet("Second");

      yield* greetingTest.resetCalls;
      const clearedState = yield* greetingTest.getState;
      expect(clearedState.calls).toEqual([]);
      expect(clearedState.response).toBe("Again, {name}!");

      const message = yield* greet("Third");
      const nextState = yield* greetingTest.getState;
      expect(message).toBe("Again, Third!");
      expect(nextState.calls).toEqual([{ name: "Third" }]);
    }).pipe(Effect.provide(GreetingServiceTest.layer)),
  );

  it.effect("reset restores the initial state", () =>
    Effect.gen(function* () {
      const greetingTest = yield* GreetingServiceTest;
      yield* greetingTest.setResponse("Before reset, {name}!");
      yield* greet("Agent");

      yield* greetingTest.reset;
      const state = yield* greetingTest.getState;

      expect(state.calls).toEqual([]);
      expect(state.response).toBeUndefined();
    }).pipe(Effect.provide(GreetingServiceTest.layer)),
  );

  it.effect("records unconfigured calls before dying", () =>
    Effect.gen(function* () {
      const greetingTest = yield* GreetingServiceTest;

      const exit = yield* Effect.exit(greet("Unconfigured"));
      const state = yield* greetingTest.getState;

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.isDie(exit.cause)).toBe(true);
        const defect = Cause.dieOption(exit.cause);
        expect(Option.isSome(defect)).toBe(true);
        if (Option.isSome(defect)) {
          expect(String(defect.value)).toContain(
            "GreetingServiceTest.greet is not configured",
          );
        }
      }
      expect(state.calls).toEqual([{ name: "Unconfigured" }]);
    }).pipe(Effect.provide(GreetingServiceTest.layer)),
  );
});
