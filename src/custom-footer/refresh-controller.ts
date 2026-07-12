import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Exit,
  Option,
  Ref,
  Scope,
} from "effect";
import {
  decideRefreshEligibility,
  type BypassRefreshCause,
  type RefreshCause,
  type RefreshSchedule,
  type RefreshSkipReason,
} from "./refresh-policy";
import { JitterService, RateLimitReaderService } from "./services";

const REFRESH_INTERVAL = Duration.minutes(5);
const AUTOMATIC_MINIMUM_GAP_MILLIS = 30_000;
const INITIAL_BACKOFF_MILLIS = 60_000;
const MAXIMUM_BACKOFF_MILLIS = 15 * 60_000;
const WAKE_THRESHOLD_MILLIS = 6 * 60_000;
const WAKE_REFRESH_DELAY = Duration.seconds(45);

export type {
  BypassRefreshCause,
  RefreshCause,
  RefreshSkipReason,
} from "./refresh-policy";

export interface FooterRefreshState {
  readonly status?: string;
  readonly stale: boolean;
  readonly failureCount: number;
  readonly nextAutomaticRefreshAt?: number;
}

export type RefreshOutcome =
  | { readonly _tag: "Success"; readonly status: string }
  | { readonly _tag: "Failure"; readonly message: string };

export type CompletedRefreshRequest =
  | { readonly _tag: "Attempted"; readonly outcome: RefreshOutcome }
  | { readonly _tag: "Joined"; readonly outcome: RefreshOutcome };

export type RefreshRequestResult =
  | CompletedRefreshRequest
  | {
      readonly _tag: "Skipped";
      readonly reason: RefreshSkipReason;
      readonly retryAt: number;
    };

export interface RenderTarget {
  readonly requestRender: () => void;
}

export interface FooterRefreshController {
  readonly getState: Effect.Effect<FooterRefreshState>;
  readonly refresh: {
    (cause: BypassRefreshCause): Effect.Effect<CompletedRefreshRequest>;
    (cause: RefreshCause): Effect.Effect<RefreshRequestResult>;
  };
  readonly start: Effect.Effect<void>;
  readonly setRenderTarget: (target: RenderTarget) => Effect.Effect<void>;
  readonly clearRenderTarget: (target: RenderTarget) => Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

export type FooterRefreshControllerConfig = Readonly<Record<never, never>>;

type RefreshDeferred = Deferred.Deferred<RefreshOutcome>;

type RefreshElection =
  | { readonly _tag: "Attempt"; readonly deferred: RefreshDeferred }
  | { readonly _tag: "Join"; readonly deferred: RefreshDeferred }
  | {
      readonly _tag: "Skip";
      readonly reason: RefreshSkipReason;
      readonly retryAt: number;
    }
  | { readonly _tag: "Closed" };

type ControllerLifecycle = {
  readonly generation: number;
  readonly acceptingRequests: boolean;
};

type ActiveLeader = {
  readonly deferred: RefreshDeferred;
  readonly fiber: Option.Option<Fiber.RuntimeFiber<void>>;
};

type DelayedWake = {
  readonly token: object;
  readonly detectedAt: number;
  readonly dueAt: number;
  readonly fiber: Option.Option<Fiber.RuntimeFiber<void>>;
};

type InternalState = RefreshSchedule & {
  readonly status?: string;
  readonly stale: boolean;
  readonly failureCount: number;
  readonly lastAttemptCompletedAt?: number;
  readonly lastOutcome?: RefreshOutcome;
  readonly activeRead: Option.Option<RefreshDeferred>;
};

const initialState: InternalState = {
  stale: false,
  failureCount: 0,
  activeRead: Option.none(),
};

const maximumDefinedDeadline = (
  left: number | undefined,
  right: number | undefined,
): number | undefined =>
  left === undefined
    ? right
    : right === undefined
      ? left
      : Math.max(left, right);

const publicState = (state: InternalState): FooterRefreshState => {
  const nextAutomaticRefreshAt = maximumDefinedDeadline(
    state.successThrottleUntil,
    state.failureBackoffUntil,
  );
  return {
    ...(state.status === undefined ? {} : { status: state.status }),
    stale: state.stale,
    failureCount: state.failureCount,
    ...(nextAutomaticRefreshAt === undefined ? {} : { nextAutomaticRefreshAt }),
  };
};

const ensureStaleSuffix = (status: string): string =>
  status.endsWith(" stale") ? status : `${status} stale`;

const interruptedOutcome: RefreshOutcome = {
  _tag: "Failure",
  message: "Refresh interrupted",
};

export const clearRefreshOwner = <A>(
  current: Option.Option<A>,
  owner: A,
): Option.Option<A> =>
  Option.isSome(current) && current.value === owner ? Option.none() : current;

export const makeRefreshController = (
  config: FooterRefreshControllerConfig,
): Effect.Effect<
  FooterRefreshController,
  never,
  RateLimitReaderService | JitterService
> =>
  Effect.gen(function* () {
    void config;
    const reader = yield* RateLimitReaderService;
    const jitter = yield* JitterService;
    const stateRef = yield* Ref.make<InternalState>(initialState);
    const initialScope = yield* Scope.make();
    const scopeRef = yield* Ref.make(initialScope);
    const lifecycleRef = yield* Ref.make<ControllerLifecycle>({
      generation: 0,
      acceptingRequests: true,
    });
    const targetRef = yield* Ref.make<Option.Option<RenderTarget>>(
      Option.none(),
    );
    const intervalFiberRef = yield* Ref.make<
      Option.Option<Fiber.RuntimeFiber<void>>
    >(Option.none());
    const delayedWakeRef = yield* Ref.make<Option.Option<DelayedWake>>(
      Option.none(),
    );
    const activeLeaderRef = yield* Ref.make<Option.Option<ActiveLeader>>(
      Option.none(),
    );
    const lastIntervalTickRef = yield* Ref.make(0);
    const lifecycleMutex = yield* Effect.makeSemaphore(1);
    const ownershipMutex = yield* Effect.makeSemaphore(1);

    const requestRender = Ref.get(targetRef).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (target) => Effect.sync(() => target.requestRender()),
        }),
      ),
    );

    const transitionFailure = (
      message: string,
    ): Effect.Effect<RefreshOutcome> =>
      Effect.gen(function* () {
        const multiplier = yield* jitter.multiplier;
        const completedAt = yield* Clock.currentTimeMillis;
        const transition = yield* Ref.modify(stateRef, (current) => {
          const failureCount = current.failureCount + 1;
          const exponential = INITIAL_BACKOFF_MILLIS * 2 ** (failureCount - 1);
          const delay = Math.min(
            exponential * multiplier,
            MAXIMUM_BACKOFF_MILLIS,
          );
          const outcome: RefreshOutcome = {
            _tag: "Failure",
            message,
          };
          const hasStatus = current.status !== undefined;
          const status =
            current.status === undefined
              ? undefined
              : ensureStaleSuffix(current.status);
          const shouldRender =
            hasStatus && (!current.stale || status !== current.status);
          const next: InternalState = {
            ...(status === undefined ? {} : { status }),
            stale: hasStatus,
            failureCount,
            lastAttemptCompletedAt: completedAt,
            failureBackoffUntil: completedAt + delay,
            lastOutcome: outcome,
            activeRead: current.activeRead,
          };
          return [{ outcome, shouldRender }, next] as const;
        });
        if (transition.shouldRender) yield* requestRender;
        return transition.outcome;
      });

    const transitionSuccess = (status: string): Effect.Effect<RefreshOutcome> =>
      Effect.gen(function* () {
        const completedAt = yield* Clock.currentTimeMillis;
        const outcome: RefreshOutcome = { _tag: "Success", status };
        yield* Ref.update(stateRef, (current) => ({
          status,
          stale: false,
          failureCount: 0,
          lastAttemptCompletedAt: completedAt,
          successThrottleUntil: completedAt + AUTOMATIC_MINIMUM_GAP_MILLIS,
          lastOutcome: outcome,
          activeRead: current.activeRead,
        }));
        yield* requestRender;
        return outcome;
      });

    const clearActiveRead = (deferred: RefreshDeferred): Effect.Effect<void> =>
      Ref.update(stateRef, (current) => {
        const activeRead = clearRefreshOwner(current.activeRead, deferred);
        return activeRead === current.activeRead
          ? current
          : { ...current, activeRead };
      });

    const clearActiveLeader = (
      deferred: RefreshDeferred,
    ): Effect.Effect<void> =>
      Ref.update(activeLeaderRef, (current) =>
        Option.isSome(current) && current.value.deferred === deferred
          ? Option.none()
          : current,
      );

    const runLeader = (deferred: RefreshDeferred): Effect.Effect<void> =>
      Effect.uninterruptibleMask((restore) =>
        restore(reader.read).pipe(
          Effect.exit,
          Effect.flatMap((readExit) => {
            if (readExit._tag === "Success") {
              return transitionSuccess(readExit.value);
            }
            if (Cause.isInterruptedOnly(readExit.cause)) {
              return Effect.succeed(interruptedOutcome);
            }
            const failure = Cause.failureOption(readExit.cause);
            const message = Option.match(failure, {
              onNone: () => Cause.pretty(readExit.cause),
              onSome: (error) => error.message,
            });
            return transitionFailure(message);
          }),
          Effect.exit,
          Effect.flatMap((transitionExit) => {
            const outcome =
              transitionExit._tag === "Success"
                ? transitionExit.value
                : ({
                    _tag: "Failure",
                    message: Cause.pretty(transitionExit.cause),
                  } satisfies RefreshOutcome);
            return Deferred.succeed(deferred, outcome);
          }),
          Effect.asVoid,
          Effect.ensuring(
            clearActiveRead(deferred).pipe(
              Effect.zipRight(clearActiveLeader(deferred)),
            ),
          ),
        ),
      );

    function refresh(
      cause: BypassRefreshCause,
    ): Effect.Effect<CompletedRefreshRequest>;
    function refresh(cause: RefreshCause): Effect.Effect<RefreshRequestResult>;
    function refresh(cause: RefreshCause): Effect.Effect<RefreshRequestResult> {
      const coordinate = ownershipMutex.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const lifecycle = yield* Ref.get(lifecycleRef);
            if (!lifecycle.acceptingRequests) {
              return { _tag: "Closed" } as const;
            }

            const now = yield* Clock.currentTimeMillis;
            const candidate = yield* Deferred.make<RefreshOutcome>();
            const election = yield* Ref.modify(
              stateRef,
              (current): readonly [RefreshElection, InternalState] => {
                const eligibility = decideRefreshEligibility(
                  cause,
                  current,
                  now,
                );
                if (eligibility._tag === "Skipped") {
                  return [
                    {
                      _tag: "Skip",
                      reason: eligibility.reason,
                      retryAt: eligibility.retryAt,
                    },
                    current,
                  ];
                }

                if (Option.isSome(current.activeRead)) {
                  return [
                    { _tag: "Join", deferred: current.activeRead.value },
                    current,
                  ];
                }

                return [
                  { _tag: "Attempt", deferred: candidate },
                  { ...current, activeRead: Option.some(candidate) },
                ];
              },
            );

            if (election._tag !== "Attempt") return election;

            yield* Ref.set(
              activeLeaderRef,
              Option.some({
                deferred: election.deferred,
                fiber: Option.none(),
              }),
            );
            const scope = yield* Ref.get(scopeRef);
            const fiber = yield* Effect.forkIn(
              Effect.interruptible(runLeader(election.deferred)),
              scope,
            );
            yield* Ref.update(activeLeaderRef, (current) =>
              Option.isSome(current) &&
              current.value.deferred === election.deferred
                ? Option.some({
                    deferred: election.deferred,
                    fiber: Option.some(fiber),
                  })
                : current,
            );
            return election;
          }),
        ),
      );

      return coordinate.pipe(
        Effect.flatMap((election): Effect.Effect<RefreshRequestResult> => {
          switch (election._tag) {
            case "Skip":
              return Effect.succeed({
                _tag: "Skipped" as const,
                reason: election.reason,
                retryAt: election.retryAt,
              });
            case "Join":
              return Deferred.await(election.deferred).pipe(
                Effect.map((outcome) => ({ _tag: "Joined" as const, outcome })),
              );
            case "Attempt":
              return Deferred.await(election.deferred).pipe(
                Effect.map((outcome) => ({
                  _tag: "Attempted" as const,
                  outcome,
                })),
              );
            case "Closed":
              return Effect.interrupt;
          }
        }),
      );
    }

    const markCachedStatusStale = Ref.modify(stateRef, (current) => {
      if (current.status === undefined || current.stale) {
        return [false, current] as const;
      }
      return [
        true,
        {
          ...current,
          status: ensureStaleSuffix(current.status),
          stale: true,
        },
      ] as const;
    }).pipe(
      Effect.flatMap((changed) => (changed ? requestRender : Effect.void)),
    );

    const clearDelayedWake = (token: object): Effect.Effect<void> =>
      Ref.update(delayedWakeRef, (current) =>
        Option.isSome(current) && current.value.token === token
          ? Option.none()
          : current,
      );

    const scheduleDelayedWakeRefresh = (detectedAt: number) =>
      Effect.gen(function* () {
        const token = {};
        const dueAt = detectedAt + Duration.toMillis(WAKE_REFRESH_DELAY);
        const shouldSchedule = yield* Ref.modify(delayedWakeRef, (current) =>
          Option.isSome(current)
            ? [false, current]
            : [
                true,
                Option.some({
                  token,
                  detectedAt,
                  dueAt,
                  fiber: Option.none(),
                }),
              ],
        );
        if (!shouldSchedule) return;

        const scope = yield* Ref.get(scopeRef);
        const fiber = yield* Effect.forkIn(
          Effect.sleep(WAKE_REFRESH_DELAY).pipe(
            Effect.zipRight(refresh("wake")),
            Effect.asVoid,
            Effect.ensuring(clearDelayedWake(token)),
          ),
          scope,
        );
        yield* Ref.update(delayedWakeRef, (current) =>
          Option.isSome(current) && current.value.token === token
            ? Option.some({
                token,
                detectedAt,
                dueAt,
                fiber: Option.some(fiber),
              })
            : current,
        );
      });

    const intervalLoop = Effect.forever(
      Effect.sleep(REFRESH_INTERVAL).pipe(
        Effect.zipRight(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const previous = yield* Ref.getAndSet(lastIntervalTickRef, now);
            if (now - previous > WAKE_THRESHOLD_MILLIS) {
              yield* markCachedStatusStale;
              yield* scheduleDelayedWakeRefresh(now);
            } else {
              yield* refresh("interval");
            }
          }),
        ),
      ),
    ).pipe(Effect.asVoid);

    const interruptOptionalFiber = <A>(
      ref: Ref.Ref<Option.Option<Fiber.RuntimeFiber<A>>>,
    ): Effect.Effect<void> =>
      Ref.getAndSet(ref, Option.none()).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
          }),
        ),
      );

    const interruptDelayedWake = Ref.getAndSet(
      delayedWakeRef,
      Option.none(),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ fiber }) =>
            Option.match(fiber, {
              onNone: () => Effect.void,
              onSome: (runningFiber) =>
                Fiber.interrupt(runningFiber).pipe(Effect.asVoid),
            }),
        }),
      ),
    );

    const interruptActiveLeader = Ref.getAndSet(
      activeLeaderRef,
      Option.none(),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ fiber }) =>
            Option.match(fiber, {
              onNone: () => Effect.void,
              onSome: (runningFiber) =>
                Fiber.interrupt(runningFiber).pipe(Effect.asVoid),
            }),
        }),
      ),
    );

    const stopFibers = interruptOptionalFiber(intervalFiberRef).pipe(
      Effect.zipRight(interruptDelayedWake),
      Effect.zipRight(interruptActiveLeader),
    );

    const replaceScope = Effect.gen(function* () {
      const next = yield* Scope.make();
      const previous = yield* Ref.getAndSet(scopeRef, next);
      yield* Scope.close(previous, Exit.void);
      return next;
    });

    const start = lifecycleMutex.withPermits(1)(
      Effect.gen(function* () {
        const scope = yield* ownershipMutex.withPermits(1)(
          Effect.gen(function* () {
            yield* stopFibers;
            const nextScope = yield* replaceScope;
            yield* Ref.update(lifecycleRef, (current) => ({
              generation: current.generation + 1,
              acceptingRequests: true,
            }));
            const now = yield* Clock.currentTimeMillis;
            yield* Ref.set(lastIntervalTickRef, now);
            const intervalFiber = yield* Effect.forkIn(intervalLoop, nextScope);
            yield* Ref.set(intervalFiberRef, Option.some(intervalFiber));
            return nextScope;
          }),
        );
        yield* Effect.forkIn(refresh("startup"), scope);
      }),
    );

    const shutdown = lifecycleMutex.withPermits(1)(
      ownershipMutex.withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.update(lifecycleRef, (current) => ({
            generation: current.generation + 1,
            acceptingRequests: false,
          }));
          yield* stopFibers;
          const scope = yield* Ref.get(scopeRef);
          yield* Scope.close(scope, Exit.void);
          yield* Ref.set(targetRef, Option.none());
        }),
      ),
    );

    return {
      getState: Ref.get(stateRef).pipe(Effect.map(publicState)),
      refresh,
      start,
      setRenderTarget: (target) => Ref.set(targetRef, Option.some(target)),
      clearRenderTarget: (target) =>
        Ref.update(targetRef, (current) =>
          Option.isSome(current) && current.value === target
            ? Option.none()
            : current,
        ),
      shutdown,
    } satisfies FooterRefreshController;
  });
