import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { expect } from "vitest";
import {
  SessionListingError,
  SessionListingService,
} from "../../src/history-picker/services";
import { HistoryPickerServicesTest } from "./history-picker";

const session = (path: string): SessionInfo => ({
  path,
  id: `id-${path}`,
  cwd: "/project",
  created: new Date("2026-01-01T00:00:00.000Z"),
  modified: new Date("2026-01-02T00:00:00.000Z"),
  messageCount: 1,
  firstMessage: "hello",
  allMessagesText: "hello",
});

describe("HistoryPickerServicesTest", () => {
  it.effect(
    "queues copied successes and typed failures while recording calls",
    () => {
      const configured = session("/sessions/one.jsonl");
      const failure = new SessionListingError({ message: "offline" });

      return Effect.gen(function* () {
        const listing = yield* SessionListingService;
        const controls = yield* HistoryPickerServicesTest;

        const first = yield* listing.listAll;
        first[0]?.created.setUTCFullYear(2000);
        Object.assign(first[0] ?? {}, { path: "/mutated" });

        yield* controls.enqueueFailure(failure);
        expect(yield* Effect.flip(listing.listAll)).toEqual(failure);

        const state = yield* controls.getState;
        expect(state.listCalls).toBe(2);
        expect(state.listingOutcomes).toEqual([]);

        yield* controls.reset;
        const reset = yield* listing.listAll;
        expect(reset[0]).toMatchObject({
          path: "/sessions/one.jsonl",
          created: new Date("2026-01-01T00:00:00.000Z"),
        });
        expect((yield* controls.getState).listCalls).toBe(1);
      }).pipe(
        Effect.provide(
          HistoryPickerServicesTest.layer({
            listingOutcomes: [{ _tag: "Success", sessions: [configured] }],
          }),
        ),
      );
    },
  );

  it.effect("records an unconfigured listing before dying", () =>
    Effect.gen(function* () {
      const listing = yield* SessionListingService;
      const controls = yield* HistoryPickerServicesTest;

      const exit = yield* Effect.exit(listing.listAll);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.isDie(exit.cause)).toBe(true);
        const defect = Cause.dieOption(exit.cause);
        expect(Option.isSome(defect)).toBe(true);
        if (Option.isSome(defect)) {
          expect(String(defect.value)).toContain(
            "HistoryPickerServicesTest listing is not configured",
          );
        }
      }
      expect((yield* controls.getState).listCalls).toBe(1);

      yield* controls.resetCalls;
      expect((yield* controls.getState).listCalls).toBe(0);
    }).pipe(Effect.provide(HistoryPickerServicesTest.layer())),
  );
});
