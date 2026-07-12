import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Either, Fiber } from "effect";
import { expect } from "vitest";
import {
  CodexRateLimitError,
  type RateLimitReadError,
} from "../../src/custom-footer/codex-json-rpc";
import {
  JitterService,
  RateLimitReaderService,
} from "../../src/custom-footer/services";
import { CustomFooterServicesTest } from "./custom-footer";

const failure = new CodexRateLimitError({
  reason: "timeout",
  message: "timed out",
});

describe("CustomFooterServicesTest", () => {
  it.effect("serves queued reader outcomes and jitter values in order", () =>
    Effect.gen(function* () {
      const reader = yield* RateLimitReaderService;
      const jitter = yield* JitterService;
      const controls = yield* CustomFooterServicesTest;

      yield* controls.enqueueSuccess("first");
      yield* controls.enqueueFailure(failure);
      yield* controls.enqueueJitter(1.1);
      yield* controls.enqueueJitter(1.2);

      expect(yield* reader.read).toBe("first");
      const failed = yield* Effect.either(reader.read);
      expect(Either.isLeft(failed)).toBe(true);
      if (Either.isLeft(failed)) expect(failed.left).toEqual(failure);
      expect(yield* jitter.multiplier).toBe(1.1);
      expect(yield* jitter.multiplier).toBe(1.2);

      expect(yield* controls.getState).toMatchObject({
        readCalls: 2,
        jitterCalls: 2,
        readerOutcomes: [],
        jitterValues: [],
      });
    }).pipe(Effect.provide(CustomFooterServicesTest.layer())),
  );

  it.effect("lets a pending read be completed after the caller begins", () =>
    Effect.gen(function* () {
      const reader = yield* RateLimitReaderService;
      const controls = yield* CustomFooterServicesTest;
      const pending = yield* controls.enqueuePending();
      const read = yield* Effect.fork(reader.read);
      yield* Effect.yieldNow();

      expect((yield* controls.getState).readCalls).toBe(1);
      yield* Deferred.succeed(pending, "completed");
      expect(yield* Fiber.join(read)).toBe("completed");
    }).pipe(Effect.provide(CustomFooterServicesTest.layer())),
  );

  it.effect(
    "records before dying when a read or jitter value is unconfigured",
    () =>
      Effect.gen(function* () {
        const reader = yield* RateLimitReaderService;
        const jitter = yield* JitterService;
        const controls = yield* CustomFooterServicesTest;

        expect((yield* Effect.exit(reader.read))._tag).toBe("Failure");
        expect((yield* Effect.exit(jitter.multiplier))._tag).toBe("Failure");
        expect(yield* controls.getState).toMatchObject({
          readCalls: 1,
          jitterCalls: 1,
        });
      }).pipe(Effect.provide(CustomFooterServicesTest.layer())),
  );

  it.effect(
    "returns isolated snapshots and implements resetCalls and reset",
    () => {
      const initialFailure: RateLimitReadError = failure;
      return Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("added");
        yield* controls.enqueueJitter(1.24);

        const first = yield* controls.getState;
        const second = yield* controls.getState;
        Object.assign(first.readerOutcomes, {
          0: { _tag: "Success", status: "mutated" },
        });
        Object.assign(first.jitterValues, { 0: 9 });
        expect(second.readerOutcomes).not.toBe(first.readerOutcomes);
        expect(second.jitterValues).not.toBe(first.jitterValues);

        const reader = yield* RateLimitReaderService;
        yield* Effect.either(reader.read);
        yield* controls.resetCalls;
        expect(yield* controls.getState).toMatchObject({ readCalls: 0 });

        yield* controls.reset;
        expect(yield* controls.getState).toMatchObject({
          readCalls: 0,
          jitterCalls: 0,
          readerOutcomes: [{ _tag: "Failure", error: initialFailure }],
          jitterValues: [1.05],
        });
      }).pipe(
        Effect.provide(
          CustomFooterServicesTest.layer({
            readerOutcomes: [{ _tag: "Failure", error: initialFailure }],
            jitterValues: [1.05],
          }),
        ),
      );
    },
  );
});
