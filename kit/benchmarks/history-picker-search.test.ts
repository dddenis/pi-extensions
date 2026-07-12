import { describe, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  TestClock,
} from "effect";
import { expect } from "vitest";
import { awaitBenchmarkPublication } from "./history-picker-search";

describe("history picker search benchmark", () => {
  it.effect(
    "fails a missing publication and runs the enclosing finalizer",
    () =>
      Effect.gen(function* () {
        const publication = yield* Deferred.make<void>();
        let finalized = false;
        const waiting = awaitBenchmarkPublication("setup", publication).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
          Effect.exit,
        );

        const fiber = yield* Effect.fork(waiting);
        yield* TestClock.adjust("30 seconds");
        const exit = yield* Fiber.join(fiber);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.isDie(exit.cause)).toBe(true);
          const defect = Cause.dieOption(exit.cause);
          expect(Option.isSome(defect)).toBe(true);
          if (Option.isSome(defect)) {
            expect(String(defect.value)).toContain(
              "setup publication exceeded the 30-second benchmark hang guard",
            );
          }
        }
        expect(finalized).toBe(true);
      }),
  );
});
