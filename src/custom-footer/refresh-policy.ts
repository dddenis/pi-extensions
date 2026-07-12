export type RoutineRefreshCause = "interval" | "turn-end";
export type BypassRefreshCause = "startup" | "wake" | "manual";
export type RefreshCause = RoutineRefreshCause | BypassRefreshCause;

export interface RefreshSchedule {
  readonly successThrottleUntil?: number;
  readonly failureBackoffUntil?: number;
}

export type RefreshSkipReason = "success-throttle" | "failure-backoff";

export type RefreshEligibility =
  | { readonly _tag: "Attempt" }
  | {
      readonly _tag: "Skipped";
      readonly reason: RefreshSkipReason;
      readonly retryAt: number;
    };

const activeDeadline = (
  deadline: number | undefined,
  now: number,
): number | undefined =>
  deadline !== undefined && now < deadline ? deadline : undefined;

export const decideRefreshEligibility = (
  cause: RefreshCause,
  schedule: RefreshSchedule,
  now: number,
): RefreshEligibility => {
  if (cause === "startup" || cause === "wake" || cause === "manual") {
    return { _tag: "Attempt" };
  }

  const successThrottleUntil = activeDeadline(
    schedule.successThrottleUntil,
    now,
  );
  const failureBackoffUntil = activeDeadline(schedule.failureBackoffUntil, now);

  if (
    failureBackoffUntil !== undefined &&
    (successThrottleUntil === undefined ||
      failureBackoffUntil >= successThrottleUntil)
  ) {
    return {
      _tag: "Skipped",
      reason: "failure-backoff",
      retryAt: failureBackoffUntil,
    };
  }
  if (successThrottleUntil !== undefined) {
    return {
      _tag: "Skipped",
      reason: "success-throttle",
      retryAt: successThrottleUntil,
    };
  }
  return { _tag: "Attempt" };
};
