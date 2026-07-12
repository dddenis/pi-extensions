import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { Context, Deferred, Effect, Layer, Ref } from "effect";
import {
  copySessionInfos,
  SessionListingError,
  SessionListingService,
  type SessionListingService as SessionListingServiceShape,
} from "../../src/history-picker/services";

export type HistoryPickerListingOutcome =
  | {
      readonly _tag: "Success";
      readonly sessions: ReadonlyArray<SessionInfo>;
    }
  | { readonly _tag: "Failure"; readonly error: SessionListingError }
  | {
      readonly _tag: "Pending";
      readonly deferred: Deferred.Deferred<
        ReadonlyArray<SessionInfo>,
        SessionListingError
      >;
    };

export interface HistoryPickerServicesTestConfig {
  readonly listingOutcomes?: ReadonlyArray<HistoryPickerListingOutcome>;
}

export interface HistoryPickerServicesTestState {
  readonly listCalls: number;
  readonly listingOutcomes: ReadonlyArray<HistoryPickerListingOutcome>;
}

export interface HistoryPickerServicesTestService {
  readonly enqueueSuccess: (
    sessions: ReadonlyArray<SessionInfo>,
  ) => Effect.Effect<void>;
  readonly enqueueFailure: (error: SessionListingError) => Effect.Effect<void>;
  readonly enqueuePending: () => Effect.Effect<
    Deferred.Deferred<ReadonlyArray<SessionInfo>, SessionListingError>
  >;
  readonly getState: Effect.Effect<HistoryPickerServicesTestState>;
  readonly resetCalls: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

type StateRef = Ref.Ref<HistoryPickerServicesTestState>;

const copyError = (error: SessionListingError): SessionListingError =>
  new SessionListingError({ message: error.message });

const copyOutcome = (
  outcome: HistoryPickerListingOutcome,
): HistoryPickerListingOutcome => {
  switch (outcome._tag) {
    case "Success":
      return { _tag: "Success", sessions: copySessionInfos(outcome.sessions) };
    case "Failure":
      return { _tag: "Failure", error: copyError(outcome.error) };
    case "Pending":
      return { _tag: "Pending", deferred: outcome.deferred };
  }
};

const initialState = (
  config: HistoryPickerServicesTestConfig,
): HistoryPickerServicesTestState => ({
  listCalls: 0,
  listingOutcomes: (config.listingOutcomes ?? []).map(copyOutcome),
});

const snapshot = (
  ref: StateRef,
): Effect.Effect<HistoryPickerServicesTestState> =>
  Ref.get(ref).pipe(
    Effect.map((state) => ({
      listCalls: state.listCalls,
      listingOutcomes: state.listingOutcomes.map(copyOutcome),
    })),
  );

const makeListing = (ref: StateRef): SessionListingServiceShape => ({
  listAll: Ref.modify(ref, (state) => {
    const outcome = state.listingOutcomes[0];
    return [
      outcome,
      {
        listCalls: state.listCalls + 1,
        listingOutcomes: state.listingOutcomes.slice(1),
      },
    ];
  }).pipe(
    Effect.flatMap((outcome) => {
      if (outcome === undefined) {
        return Effect.die(
          new Error("HistoryPickerServicesTest listing is not configured"),
        );
      }
      switch (outcome._tag) {
        case "Success":
          return Effect.succeed(copySessionInfos(outcome.sessions));
        case "Failure":
          return Effect.fail(copyError(outcome.error));
        case "Pending":
          return Deferred.await(outcome.deferred).pipe(
            Effect.map(copySessionInfos),
            Effect.mapError(copyError),
          );
      }
    }),
  ),
});

const appendOutcome = (
  ref: StateRef,
  outcome: HistoryPickerListingOutcome,
): Effect.Effect<void> =>
  Ref.update(ref, (state) => ({
    ...state,
    listingOutcomes: [...state.listingOutcomes, copyOutcome(outcome)],
  }));

const makeControls = (
  ref: StateRef,
  config: HistoryPickerServicesTestConfig,
): HistoryPickerServicesTestService => ({
  enqueueSuccess: (sessions) =>
    appendOutcome(ref, { _tag: "Success", sessions }),
  enqueueFailure: (error) => appendOutcome(ref, { _tag: "Failure", error }),
  enqueuePending: () =>
    Deferred.make<ReadonlyArray<SessionInfo>, SessionListingError>().pipe(
      Effect.tap((deferred) =>
        appendOutcome(ref, { _tag: "Pending", deferred }),
      ),
    ),
  getState: snapshot(ref),
  resetCalls: Ref.update(ref, (state) => ({ ...state, listCalls: 0 })),
  reset: Ref.set(ref, initialState(config)),
});

const makeLayer = (config: HistoryPickerServicesTestConfig = {}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const copiedConfig: HistoryPickerServicesTestConfig = {
        listingOutcomes: (config.listingOutcomes ?? []).map(copyOutcome),
      };
      const ref = yield* Ref.make(initialState(copiedConfig));
      return Context.make(SessionListingService, makeListing(ref)).pipe(
        Context.add(HistoryPickerServicesTest, makeControls(ref, copiedConfig)),
      );
    }),
  );

export class HistoryPickerServicesTest extends Context.Tag(
  "HistoryPickerServicesTest",
)<HistoryPickerServicesTest, HistoryPickerServicesTestService>() {
  static readonly layer = makeLayer;
}
