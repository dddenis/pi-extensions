import { Context, Deferred, Effect, Layer, Ref } from "effect";
import {
  CodexRateLimitError,
  type RateLimitReadError,
} from "../../src/custom-footer/codex-json-rpc";
import { RateLimitProtocolError } from "../../src/custom-footer/rate-limits";
import {
  JitterService,
  type JitterService as JitterServiceShape,
  RateLimitReaderService,
  type RateLimitReaderService as RateLimitReaderServiceShape,
} from "../../src/custom-footer/services";
import { FileSystemError } from "../../src/services/file-system";
import { ProcessError } from "../../src/services/process";

export type CustomFooterReaderOutcome =
  | { readonly _tag: "Success"; readonly status: string }
  | { readonly _tag: "Failure"; readonly error: RateLimitReadError }
  | {
      readonly _tag: "Pending";
      readonly deferred: Deferred.Deferred<string, RateLimitReadError>;
    };

export interface CustomFooterServicesTestConfig {
  readonly readerOutcomes?: ReadonlyArray<CustomFooterReaderOutcome>;
  readonly jitterValues?: ReadonlyArray<number>;
}

export interface CustomFooterServicesTestState {
  readonly readCalls: number;
  readonly jitterCalls: number;
  readonly readerOutcomes: ReadonlyArray<CustomFooterReaderOutcome>;
  readonly jitterValues: ReadonlyArray<number>;
}

export interface CustomFooterServicesTestService {
  readonly enqueueSuccess: (status: string) => Effect.Effect<void>;
  readonly enqueueFailure: (error: RateLimitReadError) => Effect.Effect<void>;
  readonly enqueuePending: () => Effect.Effect<
    Deferred.Deferred<string, RateLimitReadError>
  >;
  readonly enqueueJitter: (multiplier: number) => Effect.Effect<void>;
  readonly getState: Effect.Effect<CustomFooterServicesTestState>;
  readonly resetCalls: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

type TestStateRef = Ref.Ref<CustomFooterServicesTestState>;

const copyError = (error: RateLimitReadError): RateLimitReadError => {
  switch (error._tag) {
    case "CodexRateLimitError":
      return new CodexRateLimitError({
        reason: error.reason,
        message: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.signal === undefined ? {} : { signal: error.signal }),
        ...(error.stderr === undefined ? {} : { stderr: error.stderr }),
      });
    case "FileSystemError":
      return new FileSystemError({
        operation: error.operation,
        path: error.path,
        message: error.message,
      });
    case "ProcessError":
      return new ProcessError({
        operation: error.operation,
        message: error.message,
      });
    case "RateLimitProtocolError":
      return new RateLimitProtocolError({
        requestId: error.requestId,
        reason: error.reason,
        message: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      });
  }
};

const copyOutcome = (
  outcome: CustomFooterReaderOutcome,
): CustomFooterReaderOutcome => {
  switch (outcome._tag) {
    case "Success":
      return { _tag: "Success", status: outcome.status };
    case "Failure":
      return { _tag: "Failure", error: copyError(outcome.error) };
    case "Pending":
      return { _tag: "Pending", deferred: outcome.deferred };
  }
};

const initialState = (
  config: CustomFooterServicesTestConfig,
): CustomFooterServicesTestState => ({
  readCalls: 0,
  jitterCalls: 0,
  readerOutcomes: (config.readerOutcomes ?? []).map(copyOutcome),
  jitterValues: [...(config.jitterValues ?? [])],
});

const snapshot = (
  ref: TestStateRef,
): Effect.Effect<CustomFooterServicesTestState> =>
  Ref.get(ref).pipe(
    Effect.map((state) => ({
      readCalls: state.readCalls,
      jitterCalls: state.jitterCalls,
      readerOutcomes: state.readerOutcomes.map(copyOutcome),
      jitterValues: [...state.jitterValues],
    })),
  );

const makeReader = (ref: TestStateRef): RateLimitReaderServiceShape => ({
  read: Ref.modify(ref, (state) => {
    const outcome = state.readerOutcomes[0];
    return [
      outcome,
      {
        ...state,
        readCalls: state.readCalls + 1,
        readerOutcomes: state.readerOutcomes.slice(1),
      },
    ];
  }).pipe(
    Effect.flatMap((outcome) => {
      if (outcome === undefined) {
        return Effect.die(
          new Error("CustomFooterServicesTest reader is not configured"),
        );
      }
      switch (outcome._tag) {
        case "Success":
          return Effect.succeed(outcome.status);
        case "Failure":
          return Effect.fail(copyError(outcome.error));
        case "Pending":
          return Deferred.await(outcome.deferred);
      }
    }),
  ),
});

const makeJitter = (ref: TestStateRef): JitterServiceShape => ({
  multiplier: Ref.modify(ref, (state) => {
    const multiplier = state.jitterValues[0];
    return [
      multiplier,
      {
        ...state,
        jitterCalls: state.jitterCalls + 1,
        jitterValues: state.jitterValues.slice(1),
      },
    ];
  }).pipe(
    Effect.flatMap((multiplier) =>
      multiplier === undefined
        ? Effect.die(
            new Error("CustomFooterServicesTest jitter is not configured"),
          )
        : Effect.succeed(multiplier),
    ),
  ),
});

const appendOutcome = (
  ref: TestStateRef,
  outcome: CustomFooterReaderOutcome,
): Effect.Effect<void> =>
  Ref.update(ref, (state) => ({
    ...state,
    readerOutcomes: [...state.readerOutcomes, outcome],
  }));

const makeControls = (
  ref: TestStateRef,
  config: CustomFooterServicesTestConfig,
): CustomFooterServicesTestService => ({
  enqueueSuccess: (status) => appendOutcome(ref, { _tag: "Success", status }),
  enqueueFailure: (error) =>
    appendOutcome(ref, { _tag: "Failure", error: copyError(error) }),
  enqueuePending: () =>
    Deferred.make<string, RateLimitReadError>().pipe(
      Effect.tap((deferred) =>
        appendOutcome(ref, { _tag: "Pending", deferred }),
      ),
    ),
  enqueueJitter: (multiplier) =>
    Ref.update(ref, (state) => ({
      ...state,
      jitterValues: [...state.jitterValues, multiplier],
    })),
  getState: snapshot(ref),
  resetCalls: Ref.update(ref, (state) => ({
    ...state,
    readCalls: 0,
    jitterCalls: 0,
  })),
  reset: Ref.set(ref, initialState(config)),
});

const makeLayer = (config: CustomFooterServicesTestConfig = {}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const copiedConfig: CustomFooterServicesTestConfig = {
        readerOutcomes: (config.readerOutcomes ?? []).map(copyOutcome),
        jitterValues: [...(config.jitterValues ?? [])],
      };
      const ref = yield* Ref.make(initialState(copiedConfig));
      return Context.make(RateLimitReaderService, makeReader(ref)).pipe(
        Context.add(JitterService, makeJitter(ref)),
        Context.add(CustomFooterServicesTest, makeControls(ref, copiedConfig)),
      );
    }),
  );

export class CustomFooterServicesTest extends Context.Tag(
  "CustomFooterServicesTest",
)<CustomFooterServicesTest, CustomFooterServicesTestService>() {
  static readonly layer = makeLayer;
}
