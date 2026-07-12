import { describe, it } from "@effect/vitest";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Ref,
  TestClock,
} from "effect";
import { expect } from "vitest";
import {
  CustomFooterServicesTest,
  type CustomFooterServicesTestService,
} from "../../test/services/custom-footer";
import { CodexRateLimitError, type RateLimitReadError } from "./codex-json-rpc";
import {
  clearRefreshOwner,
  makeRefreshController,
  type RefreshOutcome,
  type RenderTarget,
} from "./refresh-controller";
import {
  type JitterService,
  RateLimitReaderService,
  type RateLimitReaderService as RateLimitReaderServiceShape,
} from "./services";

const failure = (message = "timed out") =>
  new CodexRateLimitError({ reason: "timeout", message });

const withServices = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    CustomFooterServicesTest | JitterService | RateLimitReaderService
  >,
): Effect.Effect<A, E> =>
  effect.pipe(Effect.provide(CustomFooterServicesTest.layer()));

const yieldUntil = (predicate: Effect.Effect<boolean>): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let index = 0; index < 20; index += 1) {
      if (yield* predicate) return;
      yield* Effect.yieldNow();
    }
    return yield* Effect.die(new Error("condition did not become true"));
  });

const waitForReadCalls = (
  controls: CustomFooterServicesTestService,
  count: number,
): Effect.Effect<void> =>
  yieldUntil(
    controls.getState.pipe(Effect.map((state) => state.readCalls === count)),
  );

const makeBlockingReader = Effect.gen(function* () {
  const pending = yield* Deferred.make<string, RateLimitReadError>();
  const calls = yield* Ref.make(0);
  const reader: RateLimitReaderServiceShape = {
    read: Ref.updateAndGet(calls, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        count === 1
          ? Effect.uninterruptible(Deferred.await(pending))
          : Effect.succeed(`read ${count}`),
      ),
    ),
  };
  return { pending, calls, reader } as const;
});

const waitForSuspended = <A>(
  fiber: Fiber.RuntimeFiber<A>,
): Effect.Effect<void> =>
  yieldUntil(
    Fiber.status(fiber).pipe(
      Effect.map((status) => status._tag === "Suspended"),
    ),
  );

const makeTransitionClock = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const calls = yield* Ref.make(0);
  const base = Clock.make();
  const clock: Clock.Clock = {
    ...base,
    currentTimeMillis: Ref.updateAndGet(calls, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        count === 2
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.as(0),
            )
          : Effect.succeed(0),
      ),
    ),
  };
  return { clock, entered, release } as const;
});

describe("FooterRefreshController", () => {
  it.effect(
    "starts empty, skips inside the success throttle, and attempts at equality",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueSuccess("OpenAI 5h 99% | wk 92%");
          yield* controls.enqueueSuccess("OpenAI 5h 98% | wk 91%");
          const controller = yield* makeRefreshController({});

          expect(yield* controller.getState).toEqual({
            stale: false,
            failureCount: 0,
          });
          expect(yield* controller.refresh("interval")).toEqual({
            _tag: "Attempted",
            outcome: {
              _tag: "Success",
              status: "OpenAI 5h 99% | wk 92%",
            },
          });
          expect(yield* controller.getState).toEqual({
            status: "OpenAI 5h 99% | wk 92%",
            stale: false,
            failureCount: 0,
            nextAutomaticRefreshAt: 30_000,
          });

          expect(yield* controller.refresh("turn-end")).toEqual({
            _tag: "Skipped",
            reason: "success-throttle",
            retryAt: 30_000,
          });
          expect((yield* controls.getState).readCalls).toBe(1);

          yield* TestClock.adjust(Duration.seconds(30));
          expect(yield* controller.refresh("interval")).toEqual({
            _tag: "Attempted",
            outcome: {
              _tag: "Success",
              status: "OpenAI 5h 98% | wk 91%",
            },
          });
          expect((yield* controls.getState).readCalls).toBe(2);
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect(
    "labels the leader attempted and an actual-read follower joined",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          const controller = yield* makeRefreshController({});
          const pending = yield* controls.enqueuePending();
          const first = yield* Effect.fork(controller.refresh("interval"));
          yield* waitForReadCalls(controls, 1);
          const second = yield* Effect.fork(controller.refresh("manual"));

          yield* Deferred.succeed(pending, "OpenAI 5h 99% | wk 92%");
          const outcome: RefreshOutcome = {
            _tag: "Success",
            status: "OpenAI 5h 99% | wk 92%",
          };
          expect(yield* Fiber.join(first)).toEqual({
            _tag: "Attempted",
            outcome,
          });
          expect(yield* Fiber.join(second)).toEqual({
            _tag: "Joined",
            outcome,
          });
          expect((yield* controls.getState).readCalls).toBe(1);
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect(
    "skips a throttled routine request while a manual read is active",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueSuccess("cached");
          const pending = yield* controls.enqueuePending();
          const controller = yield* makeRefreshController({});

          yield* Effect.gen(function* () {
            yield* controller.refresh("manual");
            const manual = yield* Effect.fork(controller.refresh("manual"));
            yield* waitForReadCalls(controls, 2);
            const routine = yield* Effect.fork(controller.refresh("turn-end"));
            yield* Effect.yieldNow();

            expect(Option.isSome(yield* Fiber.poll(routine))).toBe(true);
            expect(yield* Fiber.join(routine)).toEqual({
              _tag: "Skipped",
              reason: "success-throttle",
              retryAt: 30_000,
            });
            expect((yield* controls.getState).readCalls).toBe(2);

            yield* Deferred.succeed(pending, "manual");
            expect(yield* Fiber.join(manual)).toEqual({
              _tag: "Attempted",
              outcome: { _tag: "Success", status: "manual" },
            });
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(pending, "manual cleanup").pipe(
                Effect.zipRight(controller.shutdown),
              ),
            ),
          );
        }),
      ),
  );

  it.effect(
    "skips a backed-off routine request while a manual read is active",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueFailure(failure("seed backoff"));
          yield* controls.enqueueJitter(1);
          const pending = yield* controls.enqueuePending();
          const controller = yield* makeRefreshController({});

          yield* Effect.gen(function* () {
            yield* controller.refresh("manual");
            const manual = yield* Effect.fork(controller.refresh("manual"));
            yield* waitForReadCalls(controls, 2);
            const routine = yield* Effect.fork(controller.refresh("interval"));
            yield* Effect.yieldNow();

            expect(Option.isSome(yield* Fiber.poll(routine))).toBe(true);
            expect(yield* Fiber.join(routine)).toEqual({
              _tag: "Skipped",
              reason: "failure-backoff",
              retryAt: 60_000,
            });
            expect((yield* controls.getState).readCalls).toBe(2);

            yield* Deferred.succeed(pending, "manual");
            expect(yield* Fiber.join(manual)).toEqual({
              _tag: "Attempted",
              outcome: { _tag: "Success", status: "manual" },
            });
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(pending, "manual cleanup").pipe(
                Effect.zipRight(controller.shutdown),
              ),
            ),
          );
        }),
      ),
  );

  it.effect(
    "joins an active manual read when a routine request is eligible",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          const pending = yield* controls.enqueuePending();
          const controller = yield* makeRefreshController({});

          yield* Effect.gen(function* () {
            const manual = yield* Effect.fork(controller.refresh("manual"));
            yield* waitForReadCalls(controls, 1);
            const routine = yield* Effect.fork(controller.refresh("turn-end"));
            yield* waitForSuspended(routine);

            yield* Deferred.succeed(pending, "shared");
            expect(yield* Fiber.join(manual)).toEqual({
              _tag: "Attempted",
              outcome: { _tag: "Success", status: "shared" },
            });
            expect(yield* Fiber.join(routine)).toEqual({
              _tag: "Joined",
              outcome: { _tag: "Success", status: "shared" },
            });
            expect((yield* controls.getState).readCalls).toBe(1);
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(pending, "manual cleanup").pipe(
                Effect.zipRight(controller.shutdown),
              ),
            ),
          );
        }),
      ),
  );

  it.effect(
    "does not install in-flight state for a skip or absorb a manual request",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueSuccess("cached");
          yield* controls.enqueueSuccess("manual");
          const controller = yield* makeRefreshController({});
          let renderCalls = 0;
          yield* controller.setRenderTarget({
            requestRender: () => (renderCalls += 1),
          });

          yield* controller.refresh("interval");
          const stateBeforeSkip = yield* controller.getState;
          const servicesBeforeSkip = yield* controls.getState;
          expect(yield* controller.refresh("turn-end")).toEqual({
            _tag: "Skipped",
            reason: "success-throttle",
            retryAt: 30_000,
          });
          expect(yield* controller.getState).toEqual(stateBeforeSkip);
          expect(yield* controls.getState).toMatchObject({
            readCalls: servicesBeforeSkip.readCalls,
            jitterCalls: servicesBeforeSkip.jitterCalls,
            readerOutcomes: servicesBeforeSkip.readerOutcomes,
            jitterValues: servicesBeforeSkip.jitterValues,
          });
          expect(renderCalls).toBe(1);

          expect(yield* controller.refresh("manual")).toEqual({
            _tag: "Attempted",
            outcome: { _tag: "Success", status: "manual" },
          });
          expect((yield* controls.getState).readCalls).toBe(2);
          expect(renderCalls).toBe(2);
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect(
    "separates success throttling from failure backoff across real attempts",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueSuccess("first");
          yield* controls.enqueueFailure(failure("failed"));
          yield* controls.enqueueJitter(1);
          yield* controls.enqueueSuccess("recovered");
          const controller = yield* makeRefreshController({});

          yield* controller.refresh("manual");
          expect(yield* controller.getState).toMatchObject({
            nextAutomaticRefreshAt: 30_000,
            failureCount: 0,
          });

          yield* controller.refresh("manual");
          expect(yield* controller.getState).toMatchObject({
            nextAutomaticRefreshAt: 60_000,
            failureCount: 1,
            stale: true,
          });
          expect(yield* controller.refresh("interval")).toEqual({
            _tag: "Skipped",
            reason: "failure-backoff",
            retryAt: 60_000,
          });

          yield* controller.refresh("manual");
          expect(yield* controller.getState).toEqual({
            status: "recovered",
            stale: false,
            failureCount: 0,
            nextAutomaticRefreshAt: 30_000,
          });
          expect((yield* controls.getState).jitterCalls).toBe(1);
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect("sets the success deadline from reader completion", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        const pending = yield* controls.enqueuePending();
        const controller = yield* makeRefreshController({});

        const refresh = yield* Effect.fork(controller.refresh("manual"));
        yield* waitForReadCalls(controls, 1);
        yield* TestClock.adjust(Duration.minutes(10));
        yield* Deferred.succeed(pending, "completed later");
        expect(yield* Fiber.join(refresh)).toEqual({
          _tag: "Attempted",
          outcome: { _tag: "Success", status: "completed later" },
        });
        expect((yield* controller.getState).nextAutomaticRefreshAt).toBe(
          10 * 60_000 + 30_000,
        );
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect(
    "transitions a reader defect through failure backoff after success",
    () =>
      Effect.gen(function* () {
        const defect = new Error("reader defect");
        const calls = yield* Ref.make(0);
        const reader: RateLimitReaderServiceShape = {
          read: Ref.updateAndGet(calls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1 ? Effect.succeed("cached") : Effect.die(defect),
            ),
          ),
        };

        yield* Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueJitter(1);
          const controller = yield* makeRefreshController({});

          expect(yield* controller.refresh("manual")).toEqual({
            _tag: "Attempted",
            outcome: { _tag: "Success", status: "cached" },
          });
          expect(yield* controller.getState).toEqual({
            status: "cached",
            stale: false,
            failureCount: 0,
            nextAutomaticRefreshAt: 30_000,
          });

          expect(yield* controller.refresh("manual")).toEqual({
            _tag: "Attempted",
            outcome: {
              _tag: "Failure",
              message: Cause.pretty(Cause.die(defect)),
            },
          });
          expect(yield* controller.getState).toEqual({
            status: "cached stale",
            stale: true,
            failureCount: 1,
            nextAutomaticRefreshAt: 60_000,
          });
          expect(yield* controller.refresh("interval")).toEqual({
            _tag: "Skipped",
            reason: "failure-backoff",
            retryAt: 60_000,
          });
          expect((yield* controls.getState).jitterCalls).toBe(1);
          expect(yield* Ref.get(calls)).toBe(2);
          yield* controller.shutdown;
        }).pipe(
          Effect.provideService(RateLimitReaderService, reader),
          Effect.provide(CustomFooterServicesTest.layer()),
        );
      }),
  );

  it.effect("uses startup cause to bypass routine suppression on restart", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("first startup");
        yield* controls.enqueueSuccess("replacement startup");
        const controller = yield* makeRefreshController({});

        yield* controller.start;
        yield* waitForReadCalls(controls, 1);
        yield* yieldUntil(
          controller.getState.pipe(
            Effect.map((state) => state.status === "first startup"),
          ),
        );
        yield* controller.start;
        yield* waitForReadCalls(controls, 2);
        yield* yieldUntil(
          controller.getState.pipe(
            Effect.map((state) => state.status === "replacement startup"),
          ),
        );

        expect((yield* controls.getState).readCalls).toBe(2);
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect(
    "keeps the elected read owned when its electing caller is interrupted",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          const pending = yield* controls.enqueuePending();
          yield* controls.enqueueSuccess("next read");
          const controller = yield* makeRefreshController({});

          const electing = yield* Effect.fork(controller.refresh("manual"));
          yield* waitForReadCalls(controls, 1);
          yield* Fiber.interruptFork(electing);
          const electingExit = yield* Fiber.await(electing);
          expect(
            electingExit._tag === "Failure" &&
              Cause.isInterruptedOnly(electingExit.cause),
          ).toBe(true);

          const joining = yield* Effect.fork(controller.refresh("wake"));
          yield* Deferred.succeed(pending, "owned read");
          expect(yield* Fiber.join(joining)).toEqual({
            _tag: "Joined",
            outcome: { _tag: "Success", status: "owned read" },
          });
          expect(yield* controller.refresh("manual")).toEqual({
            _tag: "Attempted",
            outcome: { _tag: "Success", status: "next read" },
          });
          expect((yield* controls.getState).readCalls).toBe(2);
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect(
    "settles shutdown before reader settlement as interrupted without transition",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueuePending().pipe(Effect.asVoid);
          const controller = yield* makeRefreshController({});

          const leader = yield* Effect.fork(controller.refresh("manual"));
          yield* waitForReadCalls(controls, 1);
          const follower = yield* Effect.fork(controller.refresh("wake"));
          yield* Effect.yieldNow();
          yield* controller.shutdown;

          expect(yield* Fiber.join(leader)).toEqual({
            _tag: "Attempted",
            outcome: { _tag: "Failure", message: "Refresh interrupted" },
          });
          expect(yield* Fiber.join(follower)).toEqual({
            _tag: "Joined",
            outcome: { _tag: "Failure", message: "Refresh interrupted" },
          });
          expect(yield* controller.getState).toEqual({
            stale: false,
            failureCount: 0,
          });
          expect((yield* controls.getState).jitterCalls).toBe(0);
        }),
      ),
  );

  it.effect(
    "linearizes shutdown after reader success with its transition and outcome",
    () =>
      Effect.gen(function* () {
        const { clock, entered, release } = yield* makeTransitionClock;
        yield* withServices(
          Effect.gen(function* () {
            const controls = yield* CustomFooterServicesTest;
            yield* controls.enqueueSuccess("settled success");
            const controller = yield* makeRefreshController({});

            const refresh = yield* Effect.fork(controller.refresh("manual"));
            yield* Deferred.await(entered);
            const shutdown = yield* Effect.fork(controller.shutdown);
            yield* waitForSuspended(shutdown);
            expect(Option.isNone(yield* Fiber.poll(shutdown))).toBe(true);

            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(shutdown);
            expect(yield* Fiber.join(refresh)).toEqual({
              _tag: "Attempted",
              outcome: { _tag: "Success", status: "settled success" },
            });
            expect(yield* controller.getState).toEqual({
              status: "settled success",
              stale: false,
              failureCount: 0,
              nextAutomaticRefreshAt: 30_000,
            });
          }),
        ).pipe(Effect.withClock(clock));
      }),
  );

  it.effect(
    "linearizes shutdown after reader failure with its transition and outcome",
    () =>
      Effect.gen(function* () {
        const { clock, entered, release } = yield* makeTransitionClock;
        yield* withServices(
          Effect.gen(function* () {
            const controls = yield* CustomFooterServicesTest;
            yield* controls.enqueueFailure(failure("settled failure"));
            yield* controls.enqueueJitter(1);
            const controller = yield* makeRefreshController({});

            const refresh = yield* Effect.fork(controller.refresh("manual"));
            yield* Deferred.await(entered);
            const shutdown = yield* Effect.fork(controller.shutdown);
            yield* waitForSuspended(shutdown);
            expect(Option.isNone(yield* Fiber.poll(shutdown))).toBe(true);

            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(shutdown);
            expect(yield* Fiber.join(refresh)).toEqual({
              _tag: "Attempted",
              outcome: { _tag: "Failure", message: "settled failure" },
            });
            expect(yield* controller.getState).toEqual({
              stale: false,
              failureCount: 1,
              nextAutomaticRefreshAt: 60_000,
            });
            expect((yield* controls.getState).jitterCalls).toBe(1);
          }),
        ).pipe(Effect.withClock(clock));
      }),
  );

  it.effect("does not let an older deferred clear replacement ownership", () =>
    Effect.gen(function* () {
      const older = yield* Deferred.make<RefreshOutcome>();
      const replacement = yield* Deferred.make<RefreshOutcome>();

      const retained = clearRefreshOwner(Option.some(replacement), older);
      expect(Option.isSome(retained) && retained.value === replacement).toBe(
        true,
      );
      expect(Option.isNone(clearRefreshOwner(retained, replacement))).toBe(
        true,
      );
    }),
  );

  it.effect(
    "interrupts a refresh queued behind shutdown without stale ownership",
    () =>
      Effect.gen(function* () {
        const { pending, calls, reader } = yield* makeBlockingReader;
        yield* Effect.gen(function* () {
          const controller = yield* makeRefreshController({});
          const active = yield* Effect.fork(controller.refresh("manual"));
          yield* yieldUntil(
            Ref.get(calls).pipe(Effect.map((count) => count === 1)),
          );

          const shutdown = yield* Effect.fork(controller.shutdown);
          yield* waitForSuspended(shutdown);
          const queued = yield* Effect.fork(controller.refresh("manual"));
          yield* waitForSuspended(queued);

          yield* Deferred.succeed(pending, "old generation");
          yield* Fiber.join(active);
          yield* Fiber.join(shutdown);
          const queuedExit = yield* Fiber.await(queued);
          expect(
            queuedExit._tag === "Failure" &&
              Cause.isInterruptedOnly(queuedExit.cause),
          ).toBe(true);

          yield* controller.start;
          yield* yieldUntil(
            Ref.get(calls).pipe(Effect.map((count) => count === 2)),
          );
          expect((yield* controller.getState).status).toBe("read 2");
          yield* controller.shutdown;
        }).pipe(
          Effect.provideService(RateLimitReaderService, reader),
          Effect.provide(CustomFooterServicesTest.layer()),
        );
      }),
  );

  it.effect("invalidates on success and resets stale failure state", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("fresh one");
        yield* controls.enqueueFailure(failure());
        yield* controls.enqueueJitter(1);
        yield* controls.enqueueSuccess("fresh two");
        const controller = yield* makeRefreshController({});
        let renderCalls = 0;
        yield* controller.setRenderTarget({
          requestRender: () => (renderCalls += 1),
        });

        yield* controller.refresh("manual");
        yield* controller.refresh("manual");
        expect(yield* controller.getState).toMatchObject({
          status: "fresh one stale",
          stale: true,
          failureCount: 1,
          nextAutomaticRefreshAt: 60_000,
        });
        yield* controller.refresh("manual");
        expect(yield* controller.getState).toEqual({
          status: "fresh two",
          stale: false,
          failureCount: 0,
          nextAutomaticRefreshAt: 30_000,
        });
        expect(renderCalls).toBe(3);
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect(
    "keeps the first failure silent and appends stale exactly once",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueFailure(failure("first"));
          yield* controls.enqueueJitter(1);
          yield* controls.enqueueSuccess("cached");
          yield* controls.enqueueFailure(failure("second"));
          yield* controls.enqueueJitter(1);
          yield* controls.enqueueFailure(failure("third"));
          yield* controls.enqueueJitter(1);
          const controller = yield* makeRefreshController({});
          let renderCalls = 0;
          yield* controller.setRenderTarget({
            requestRender: () => (renderCalls += 1),
          });

          expect(yield* controller.refresh("interval")).toEqual({
            _tag: "Attempted",
            outcome: { _tag: "Failure", message: "first" },
          });
          expect(yield* controller.getState).toEqual({
            stale: false,
            failureCount: 1,
            nextAutomaticRefreshAt: 60_000,
          });
          expect(renderCalls).toBe(0);

          yield* controller.refresh("manual");
          yield* controller.refresh("manual");
          yield* controller.refresh("manual");
          expect(yield* controller.getState).toMatchObject({
            status: "cached stale",
            stale: true,
            failureCount: 2,
          });
          expect(renderCalls).toBe(2);
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect("uses jittered exponential backoff capped at 15 minutes", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        const controller = yield* makeRefreshController({});
        const expectedDelays = [
          60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
        ];
        const multipliers = [1, 1, 1, 1, 1.2, 1.24];

        for (let index = 0; index < expectedDelays.length; index += 1) {
          yield* controls.enqueueFailure(failure(`failure ${index + 1}`));
          yield* controls.enqueueJitter(multipliers[index] ?? 1);
          yield* controller.refresh("manual");
          expect((yield* controller.getState).nextAutomaticRefreshAt).toBe(
            expectedDelays[index],
          );
        }
        expect((yield* controls.getState).jitterCalls).toBe(6);
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect(
    "lets manual refresh bypass gap and backoff while surfacing failure",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueFailure(failure("automatic failed"));
          yield* controls.enqueueJitter(1.2);
          yield* controls.enqueueFailure(failure("manual failed"));
          yield* controls.enqueueJitter(1);
          const controller = yield* makeRefreshController({});

          yield* controller.refresh("interval");
          expect((yield* controller.getState).nextAutomaticRefreshAt).toBe(
            72_000,
          );
          expect(yield* controller.refresh("turn-end")).toEqual({
            _tag: "Skipped",
            reason: "failure-backoff",
            retryAt: 72_000,
          });
          expect((yield* controls.getState).readCalls).toBe(1);
          expect(yield* controller.refresh("manual")).toEqual({
            _tag: "Attempted",
            outcome: { _tag: "Failure", message: "manual failed" },
          });
          expect((yield* controls.getState).readCalls).toBe(2);
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect(
    "runs an initial refresh and then refreshes every five minutes",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueSuccess("initial");
          yield* controls.enqueueSuccess("interval");
          const controller = yield* makeRefreshController({});

          yield* controller.start;
          yield* waitForReadCalls(controls, 1);
          yield* TestClock.adjust(Duration.minutes(4));
          expect((yield* controls.getState).readCalls).toBe(1);
          yield* TestClock.adjust(Duration.minutes(1));
          yield* waitForReadCalls(controls, 2);
          expect((yield* controller.getState).status).toBe("interval");
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect("does not treat exactly six minutes as a wake", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("before boundary");
        const blockedInterval = yield* controls.enqueuePending();
        yield* controls.enqueueSuccess("at boundary");
        yield* controls.enqueueSuccess("must not be delayed");
        const controller = yield* makeRefreshController({});

        yield* controller.start;
        yield* waitForReadCalls(controls, 1);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* waitForReadCalls(controls, 2);
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Deferred.succeed(blockedInterval, "before boundary");
        yield* Effect.yieldNow();
        yield* TestClock.adjust(Duration.minutes(5));
        yield* waitForReadCalls(controls, 3);
        expect(yield* controller.getState).toMatchObject({
          status: "at boundary",
          stale: false,
        });

        yield* TestClock.adjust(Duration.seconds(45));
        expect((yield* controls.getState).readCalls).toBe(3);
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect(
    "detects one millisecond beyond six minutes and schedules one refresh after 45 seconds",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueSuccess("before sleep");
          const blockedInterval = yield* controls.enqueuePending();
          yield* controls.enqueueSuccess("after wake");
          const controller = yield* makeRefreshController({});

          yield* controller.start;
          yield* waitForReadCalls(controls, 1);
          yield* TestClock.adjust(Duration.minutes(5));
          yield* waitForReadCalls(controls, 2);
          yield* TestClock.adjust(Duration.minutes(1));
          yield* TestClock.adjust(Duration.millis(1));
          yield* Deferred.succeed(blockedInterval, "before sleep");
          yield* Effect.yieldNow();
          yield* TestClock.adjust(Duration.minutes(5));
          expect(yield* controller.getState).toMatchObject({
            status: "before sleep stale",
            stale: true,
          });
          expect((yield* controls.getState).readCalls).toBe(2);
          yield* TestClock.adjust(Duration.seconds(44));
          expect((yield* controls.getState).readCalls).toBe(2);
          yield* TestClock.adjust(Duration.seconds(1));
          yield* waitForReadCalls(controls, 3);
          expect((yield* controller.getState).status).toBe("after wake");
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect("shutdown cancels a delayed wake refresh", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("before sleep");
        const blockedInterval = yield* controls.enqueuePending();
        yield* controls.enqueueSuccess("must not refresh");
        const controller = yield* makeRefreshController({});

        yield* controller.start;
        yield* waitForReadCalls(controls, 1);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* waitForReadCalls(controls, 2);
        yield* TestClock.adjust(Duration.minutes(7));
        yield* Deferred.succeed(blockedInterval, "before sleep");
        yield* Effect.yieldNow();
        yield* TestClock.adjust(Duration.minutes(5));
        expect((yield* controller.getState).stale).toBe(true);

        yield* controller.shutdown;
        yield* TestClock.adjust(Duration.seconds(45));
        expect((yield* controls.getState).readCalls).toBe(2);
      }),
    ),
  );

  it.effect("bypasses five-failure backoff for the delayed wake attempt", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        for (let index = 1; index <= 4; index += 1) {
          yield* controls.enqueueFailure(failure(`failure ${index}`));
          yield* controls.enqueueJitter(1);
        }
        const fifth = yield* controls.enqueuePending();
        yield* controls.enqueueJitter(1);
        yield* controls.enqueueSuccess("wake recovery");
        const controller = yield* makeRefreshController({});

        yield* controller.start;
        yield* waitForReadCalls(controls, 1);
        yield* yieldUntil(
          controller.getState.pipe(
            Effect.map((state) => state.failureCount === 1),
          ),
        );
        for (let index = 0; index < 3; index += 1) {
          yield* controller.refresh("manual");
        }
        expect((yield* controller.getState).failureCount).toBe(4);

        yield* TestClock.adjust(Duration.minutes(5));
        expect((yield* controls.getState).readCalls).toBe(4);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* waitForReadCalls(controls, 5);

        yield* TestClock.adjust(Duration.minutes(7));
        yield* Deferred.fail(fifth, failure("failure 5"));
        yield* Effect.yieldNow();
        expect(yield* controller.getState).toMatchObject({
          failureCount: 5,
          nextAutomaticRefreshAt: 32 * 60_000,
        });

        yield* TestClock.adjust(Duration.minutes(5));
        expect((yield* controls.getState).readCalls).toBe(5);
        yield* TestClock.adjust(Duration.seconds(44));
        expect((yield* controls.getState).readCalls).toBe(5);
        yield* TestClock.adjust(Duration.seconds(1));
        yield* waitForReadCalls(controls, 6);
        expect(yield* controller.getState).toMatchObject({
          status: "wake recovery",
          stale: false,
          failureCount: 0,
        });
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect("does not cancel a wake demand after a manual refresh", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("before sleep");
        const interval = yield* controls.enqueuePending();
        yield* controls.enqueueSuccess("manual during delay");
        yield* controls.enqueueSuccess("wake after manual");
        const controller = yield* makeRefreshController({});

        yield* controller.start;
        yield* waitForReadCalls(controls, 1);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* waitForReadCalls(controls, 2);
        yield* TestClock.adjust(Duration.minutes(7));
        yield* Deferred.succeed(interval, "before sleep");
        yield* Effect.yieldNow();
        yield* TestClock.adjust(Duration.minutes(5));

        yield* controller.refresh("manual");
        expect((yield* controls.getState).readCalls).toBe(3);
        yield* TestClock.adjust(Duration.seconds(45));
        yield* waitForReadCalls(controls, 4);
        expect((yield* controller.getState).status).toBe("wake after manual");
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect("joins an actual read when the wake demand becomes due", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("before sleep");
        const interval = yield* controls.enqueuePending();
        const manual = yield* controls.enqueuePending();
        const controller = yield* makeRefreshController({});

        yield* controller.start;
        yield* waitForReadCalls(controls, 1);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* waitForReadCalls(controls, 2);
        yield* TestClock.adjust(Duration.minutes(7));
        yield* Deferred.succeed(interval, "before sleep");
        yield* Effect.yieldNow();
        yield* TestClock.adjust(Duration.minutes(5));
        yield* TestClock.adjust(Duration.seconds(44));

        const active = yield* Effect.fork(controller.refresh("manual"));
        yield* waitForReadCalls(controls, 3);
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow();
        expect((yield* controls.getState).readCalls).toBe(3);

        yield* Deferred.succeed(manual, "shared recovery");
        expect(yield* Fiber.join(active)).toEqual({
          _tag: "Attempted",
          outcome: { _tag: "Success", status: "shared recovery" },
        });
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect(
    "keeps one demand across another wake observation while it is owned",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          yield* controls.enqueueSuccess("before sleep");
          const interval = yield* controls.enqueuePending();
          const wake = yield* controls.enqueuePending();
          yield* controls.enqueueSuccess("must remain queued");
          const controller = yield* makeRefreshController({});

          yield* controller.start;
          yield* waitForReadCalls(controls, 1);
          yield* TestClock.adjust(Duration.minutes(5));
          yield* waitForReadCalls(controls, 2);
          yield* TestClock.adjust(Duration.minutes(7));
          yield* Deferred.succeed(interval, "before sleep");
          yield* Effect.yieldNow();
          yield* TestClock.adjust(Duration.minutes(5));
          yield* TestClock.adjust(Duration.seconds(45));
          yield* waitForReadCalls(controls, 3);

          yield* TestClock.adjust(Duration.minutes(7));
          expect((yield* controls.getState).readCalls).toBe(3);
          expect((yield* controls.getState).readerOutcomes).toHaveLength(1);

          yield* Deferred.succeed(wake, "wake settled");
          yield* Effect.yieldNow();
          yield* TestClock.adjust(Duration.seconds(45));
          expect((yield* controls.getState).readCalls).toBe(3);
          expect((yield* controls.getState).readerOutcomes).toHaveLength(1);
          yield* controller.shutdown;
        }),
      ),
  );

  it.effect("uses a failed wake attempt to back off later routine work", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("before sleep");
        const interval = yield* controls.enqueuePending();
        yield* controls.enqueueFailure(failure("wake failed"));
        yield* controls.enqueueJitter(1);
        yield* controls.enqueueSuccess("must remain queued");
        const controller = yield* makeRefreshController({});

        yield* controller.start;
        yield* waitForReadCalls(controls, 1);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* waitForReadCalls(controls, 2);
        yield* TestClock.adjust(Duration.minutes(7));
        yield* Deferred.succeed(interval, "before sleep");
        yield* Effect.yieldNow();
        yield* TestClock.adjust(Duration.minutes(5));
        yield* TestClock.adjust(Duration.seconds(45));
        yield* waitForReadCalls(controls, 3);
        yield* yieldUntil(
          controller.getState.pipe(
            Effect.map((state) => state.failureCount === 1),
          ),
        );

        const state = yield* controller.getState;
        expect(state.stale).toBe(true);
        expect(yield* controller.refresh("turn-end")).toEqual({
          _tag: "Skipped",
          reason: "failure-backoff",
          retryAt: state.nextAutomaticRefreshAt,
        });
        expect((yield* controls.getState).readCalls).toBe(3);
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect("shutdown interrupts an active wake read", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("before sleep");
        const interval = yield* controls.enqueuePending();
        const wake = yield* controls.enqueuePending();
        const controller = yield* makeRefreshController({});

        yield* controller.start;
        yield* waitForReadCalls(controls, 1);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* waitForReadCalls(controls, 2);
        yield* TestClock.adjust(Duration.minutes(7));
        yield* Deferred.succeed(interval, "before sleep");
        yield* Effect.yieldNow();
        yield* TestClock.adjust(Duration.minutes(5));
        yield* TestClock.adjust(Duration.seconds(45));
        yield* waitForReadCalls(controls, 3);

        yield* controller.shutdown;
        yield* Deferred.succeed(wake, "too late");
        yield* Effect.yieldNow();
        expect((yield* controller.getState).status).toBe("before sleep stale");
        expect((yield* controls.getState).readCalls).toBe(3);
      }),
    ),
  );

  it.effect("clears render targets only by identity", () =>
    withServices(
      Effect.gen(function* () {
        const controls = yield* CustomFooterServicesTest;
        yield* controls.enqueueSuccess("first");
        yield* controls.enqueueSuccess("second");
        const controller = yield* makeRefreshController({});
        let firstCalls = 0;
        let secondCalls = 0;
        const first: RenderTarget = { requestRender: () => (firstCalls += 1) };
        const second: RenderTarget = {
          requestRender: () => (secondCalls += 1),
        };

        yield* controller.setRenderTarget(first);
        yield* controller.setRenderTarget(second);
        yield* controller.clearRenderTarget(first);
        yield* controller.refresh("manual");
        expect(firstCalls).toBe(0);
        expect(secondCalls).toBe(1);
        yield* controller.clearRenderTarget(second);
        yield* controller.refresh("manual");
        expect(secondCalls).toBe(1);
        yield* controller.shutdown;
      }),
    ),
  );

  it.effect(
    "serializes overlapping starts so the last start owns one interval",
    () =>
      Effect.gen(function* () {
        const { pending, calls, reader } = yield* makeBlockingReader;
        yield* Effect.gen(function* () {
          const controller = yield* makeRefreshController({});
          yield* controller.start;
          yield* yieldUntil(
            Ref.get(calls).pipe(Effect.map((count) => count === 1)),
          );

          const firstReplacement = yield* Effect.fork(controller.start);
          yield* waitForSuspended(firstReplacement);
          const lastReplacement = yield* Effect.fork(controller.start);
          yield* waitForSuspended(lastReplacement);
          yield* Deferred.succeed(pending, "old initial");
          yield* Fiber.join(firstReplacement);
          yield* Fiber.join(lastReplacement);

          yield* Effect.yieldNow();
          const callsAfterStarts = yield* Ref.get(calls);
          yield* TestClock.adjust(Duration.minutes(5));
          yield* yieldUntil(
            Ref.get(calls).pipe(
              Effect.map((count) => count === callsAfterStarts + 1),
            ),
          );
          expect(yield* Ref.get(calls)).toBe(callsAfterStarts + 1);
          expect((yield* controller.getState).status).toBe(
            `read ${callsAfterStarts + 1}`,
          );
          yield* controller.shutdown;
        }).pipe(
          Effect.provideService(RateLimitReaderService, reader),
          Effect.provide(CustomFooterServicesTest.layer()),
        );
      }),
  );

  it.effect(
    "serializes overlapping start and shutdown without resurrecting work",
    () =>
      Effect.gen(function* () {
        const { pending, calls, reader } = yield* makeBlockingReader;
        yield* Effect.gen(function* () {
          const controller = yield* makeRefreshController({});
          yield* controller.start;
          yield* yieldUntil(
            Ref.get(calls).pipe(Effect.map((count) => count === 1)),
          );

          const restarting = yield* Effect.fork(controller.start);
          yield* waitForSuspended(restarting);
          const stopping = yield* Effect.fork(controller.shutdown);
          const repeatedStop = yield* Effect.fork(controller.shutdown);
          yield* waitForSuspended(stopping);
          yield* waitForSuspended(repeatedStop);
          yield* Deferred.succeed(pending, "old initial");
          yield* Fiber.join(restarting);
          yield* Fiber.join(stopping);
          yield* Fiber.join(repeatedStop);
          const callsAfterShutdown = yield* Ref.get(calls);

          yield* TestClock.adjust(Duration.minutes(10));
          expect(yield* Ref.get(calls)).toBe(callsAfterShutdown);
          yield* controller.shutdown;
          expect(yield* Ref.get(calls)).toBe(callsAfterShutdown);
        }).pipe(
          Effect.provideService(RateLimitReaderService, reader),
          Effect.provide(CustomFooterServicesTest.layer()),
        );
      }),
  );

  it.effect(
    "double start replaces old work and shutdown interrupts all work idempotently",
    () =>
      withServices(
        Effect.gen(function* () {
          const controls = yield* CustomFooterServicesTest;
          const firstPending = yield* controls.enqueuePending();
          yield* controls.enqueueSuccess("replacement");
          const controller = yield* makeRefreshController({});

          yield* controller.start;
          yield* waitForReadCalls(controls, 1);
          yield* controller.start;
          yield* waitForReadCalls(controls, 2);
          expect((yield* controller.getState).status).toBe("replacement");

          const activePending = yield* controls.enqueuePending();
          const active = yield* Effect.fork(controller.refresh("manual"));
          yield* waitForReadCalls(controls, 3);
          yield* controller.shutdown;
          yield* controller.shutdown;
          yield* Deferred.succeed(activePending, "too late");
          yield* Deferred.succeed(firstPending, "also too late");
          yield* controls.enqueueSuccess("interval must not run");
          yield* TestClock.adjust(Duration.minutes(10));
          expect((yield* controller.getState).status).toBe("replacement");
          expect((yield* controls.getState).readCalls).toBe(3);
          expect(yield* Fiber.poll(active)).toBeDefined();
        }),
      ),
  );
});
