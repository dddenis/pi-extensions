import { describe, expect, it } from "vitest";
import {
  decideRefreshEligibility,
  type RefreshCause,
  type RefreshEligibility,
  type RefreshSchedule,
} from "./refresh-policy";

const NOW = 1_000;
const SUCCESS_DEADLINE = 2_000;
const FAILURE_DEADLINE = 3_000;

const cases: ReadonlyArray<{
  readonly cause: RefreshCause;
  readonly schedule: RefreshSchedule;
  readonly expected: RefreshEligibility;
}> = [
  { cause: "interval", schedule: {}, expected: { _tag: "Attempt" } },
  {
    cause: "interval",
    schedule: { successThrottleUntil: SUCCESS_DEADLINE },
    expected: {
      _tag: "Skipped",
      reason: "success-throttle",
      retryAt: SUCCESS_DEADLINE,
    },
  },
  {
    cause: "interval",
    schedule: { failureBackoffUntil: FAILURE_DEADLINE },
    expected: {
      _tag: "Skipped",
      reason: "failure-backoff",
      retryAt: FAILURE_DEADLINE,
    },
  },
  {
    cause: "interval",
    schedule: {
      successThrottleUntil: SUCCESS_DEADLINE,
      failureBackoffUntil: FAILURE_DEADLINE,
    },
    expected: {
      _tag: "Skipped",
      reason: "failure-backoff",
      retryAt: FAILURE_DEADLINE,
    },
  },
  { cause: "turn-end", schedule: {}, expected: { _tag: "Attempt" } },
  {
    cause: "turn-end",
    schedule: { successThrottleUntil: SUCCESS_DEADLINE },
    expected: {
      _tag: "Skipped",
      reason: "success-throttle",
      retryAt: SUCCESS_DEADLINE,
    },
  },
  {
    cause: "turn-end",
    schedule: { failureBackoffUntil: FAILURE_DEADLINE },
    expected: {
      _tag: "Skipped",
      reason: "failure-backoff",
      retryAt: FAILURE_DEADLINE,
    },
  },
  {
    cause: "turn-end",
    schedule: {
      successThrottleUntil: FAILURE_DEADLINE,
      failureBackoffUntil: SUCCESS_DEADLINE,
    },
    expected: {
      _tag: "Skipped",
      reason: "success-throttle",
      retryAt: FAILURE_DEADLINE,
    },
  },
  { cause: "startup", schedule: {}, expected: { _tag: "Attempt" } },
  {
    cause: "startup",
    schedule: { successThrottleUntil: SUCCESS_DEADLINE },
    expected: { _tag: "Attempt" },
  },
  {
    cause: "startup",
    schedule: { failureBackoffUntil: FAILURE_DEADLINE },
    expected: { _tag: "Attempt" },
  },
  {
    cause: "startup",
    schedule: {
      successThrottleUntil: SUCCESS_DEADLINE,
      failureBackoffUntil: FAILURE_DEADLINE,
    },
    expected: { _tag: "Attempt" },
  },
  { cause: "wake", schedule: {}, expected: { _tag: "Attempt" } },
  {
    cause: "wake",
    schedule: { successThrottleUntil: SUCCESS_DEADLINE },
    expected: { _tag: "Attempt" },
  },
  {
    cause: "wake",
    schedule: { failureBackoffUntil: FAILURE_DEADLINE },
    expected: { _tag: "Attempt" },
  },
  {
    cause: "wake",
    schedule: {
      successThrottleUntil: SUCCESS_DEADLINE,
      failureBackoffUntil: FAILURE_DEADLINE,
    },
    expected: { _tag: "Attempt" },
  },
  { cause: "manual", schedule: {}, expected: { _tag: "Attempt" } },
  {
    cause: "manual",
    schedule: { successThrottleUntil: SUCCESS_DEADLINE },
    expected: { _tag: "Attempt" },
  },
  {
    cause: "manual",
    schedule: { failureBackoffUntil: FAILURE_DEADLINE },
    expected: { _tag: "Attempt" },
  },
  {
    cause: "manual",
    schedule: {
      successThrottleUntil: SUCCESS_DEADLINE,
      failureBackoffUntil: FAILURE_DEADLINE,
    },
    expected: { _tag: "Attempt" },
  },
];

describe("decideRefreshEligibility", () => {
  it.each(cases)("returns $expected._tag for $cause and $schedule", (entry) => {
    expect(decideRefreshEligibility(entry.cause, entry.schedule, NOW)).toEqual(
      entry.expected,
    );
  });

  it("treats exact routine deadline equality as eligible", () => {
    expect(
      decideRefreshEligibility(
        "interval",
        {
          successThrottleUntil: NOW,
          failureBackoffUntil: NOW,
        },
        NOW,
      ),
    ).toEqual({ _tag: "Attempt" });
  });

  it("uses failure backoff as the deterministic equal-deadline tie-break", () => {
    expect(
      decideRefreshEligibility(
        "turn-end",
        {
          successThrottleUntil: FAILURE_DEADLINE,
          failureBackoffUntil: FAILURE_DEADLINE,
        },
        NOW,
      ),
    ).toEqual({
      _tag: "Skipped",
      reason: "failure-backoff",
      retryAt: FAILURE_DEADLINE,
    });
  });

  it("does not mutate the supplied scheduling state", () => {
    const schedule: RefreshSchedule = Object.freeze({
      successThrottleUntil: SUCCESS_DEADLINE,
      failureBackoffUntil: FAILURE_DEADLINE,
    });
    const before = { ...schedule };

    decideRefreshEligibility("interval", schedule, NOW);

    expect(schedule).toEqual(before);
  });
});
