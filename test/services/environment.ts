import { Context, Effect, Layer, Ref } from "effect";
import { EnvironmentService } from "../../src/services/environment";

export interface EnvironmentServiceTestConfig {
  readonly values?: Readonly<Record<string, string>>;
}

export interface EnvironmentServiceTestCall {
  readonly name: string;
}

export interface EnvironmentServiceTestState {
  readonly calls: ReadonlyArray<EnvironmentServiceTestCall>;
  readonly values: Readonly<Record<string, string>>;
}

interface EnvironmentServiceTestInternalState {
  readonly calls: ReadonlyArray<EnvironmentServiceTestCall>;
  readonly values: Readonly<Record<string, string>>;
}

export interface EnvironmentServiceTestService {
  readonly setValues: (
    values: Readonly<Record<string, string>>,
  ) => Effect.Effect<void>;
  readonly getState: Effect.Effect<EnvironmentServiceTestState>;
  readonly resetCalls: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

type EnvironmentServiceTestRef = Ref.Ref<EnvironmentServiceTestInternalState>;

const makeInitialState = (
  config: EnvironmentServiceTestConfig = {},
): EnvironmentServiceTestInternalState => ({
  calls: [],
  values: { ...config.values },
});

const snapshotState = (
  ref: EnvironmentServiceTestRef,
): Effect.Effect<EnvironmentServiceTestState> =>
  Ref.get(ref).pipe(
    Effect.map((state) => ({
      calls: state.calls.map((call) => ({ ...call })),
      values: { ...state.values },
    })),
  );

const makeEnvironmentService = (
  ref: EnvironmentServiceTestRef,
): EnvironmentService => ({
  get: (name) =>
    Ref.modify(ref, (state) => [
      state.values[name],
      { ...state, calls: [...state.calls, { name }] },
    ]),
  snapshot: Ref.get(ref).pipe(Effect.map((state) => ({ ...state.values }))),
});

const makeEnvironmentServiceTest = (
  ref: EnvironmentServiceTestRef,
  initialConfig: EnvironmentServiceTestConfig,
): EnvironmentServiceTestService => ({
  setValues: (values) =>
    Ref.update(ref, (state) => ({ ...state, values: { ...values } })),
  getState: snapshotState(ref),
  resetCalls: Ref.update(ref, (state) => ({ ...state, calls: [] })),
  reset: Ref.set(ref, makeInitialState(initialConfig)),
});

const makeEnvironmentServiceTestLayer = (
  config: EnvironmentServiceTestConfig = {},
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const initialConfig = { values: { ...config.values } };
      const ref = yield* Ref.make(makeInitialState(initialConfig));
      const controls = makeEnvironmentServiceTest(ref, initialConfig);
      const fake = makeEnvironmentService(ref);

      return Context.add(
        Context.make(EnvironmentService, fake),
        EnvironmentServiceTest,
        controls,
      );
    }),
  );

export class EnvironmentServiceTest extends Context.Tag(
  "EnvironmentServiceTest",
)<EnvironmentServiceTest, EnvironmentServiceTestService>() {
  static readonly layer = makeEnvironmentServiceTestLayer;
}
