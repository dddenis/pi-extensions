import { Context, Effect, Layer, Ref } from "effect";
import { GreetingService } from "../../src/services/greeting";

export interface GreetingServiceTestConfig {
  readonly response?: string;
}

export interface GreetingServiceTestCall {
  readonly name: string;
}

export interface GreetingServiceTestState {
  readonly calls: ReadonlyArray<GreetingServiceTestCall>;
  readonly response?: string;
}

interface GreetingServiceTestInternalState {
  readonly calls: ReadonlyArray<GreetingServiceTestCall>;
  readonly response?: string;
}

export interface GreetingServiceTestService {
  readonly setResponse: (response: string) => Effect.Effect<void>;
  readonly getState: Effect.Effect<GreetingServiceTestState>;
  readonly resetCalls: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

type GreetingServiceTestRef = Ref.Ref<GreetingServiceTestInternalState>;

const makeInitialState = (
  config: GreetingServiceTestConfig = {},
): GreetingServiceTestInternalState => ({
  calls: [],
  response: config.response,
});

const snapshotState = (
  ref: GreetingServiceTestRef,
): Effect.Effect<GreetingServiceTestState> =>
  Ref.get(ref).pipe(
    Effect.map((state) => ({
      calls: state.calls.map((call) => ({ ...call })),
      response: state.response,
    })),
  );

const renderResponse = (template: string, name: string): string =>
  template.replaceAll("{name}", name);

const makeGreetingService = (ref: GreetingServiceTestRef): GreetingService => ({
  greet: (name) =>
    Ref.modify(ref, (state) => {
      const nextState = {
        ...state,
        calls: [...state.calls, { name }],
      };
      return [state.response, nextState] as const;
    }).pipe(
      Effect.flatMap((response) => {
        if (response === undefined) {
          return Effect.die(
            new Error("GreetingServiceTest.greet is not configured"),
          );
        }
        return Effect.succeed(renderResponse(response, name));
      }),
    ),
});

const makeGreetingServiceTest = (
  ref: GreetingServiceTestRef,
  initialConfig: GreetingServiceTestConfig,
): GreetingServiceTestService => ({
  setResponse: (response) =>
    Ref.update(ref, (state) => ({ ...state, response })),
  getState: snapshotState(ref),
  resetCalls: Ref.update(ref, (state) => ({ ...state, calls: [] })),
  reset: Ref.set(ref, makeInitialState(initialConfig)),
});

const makeGreetingServiceTestLayer = (config: GreetingServiceTestConfig = {}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const ref = yield* Ref.make(makeInitialState(config));
      const controls = makeGreetingServiceTest(ref, config);
      const fake = makeGreetingService(ref);

      return Context.add(
        Context.make(GreetingService, fake),
        GreetingServiceTest,
        controls,
      );
    }),
  );

export class GreetingServiceTest extends Context.Tag("GreetingServiceTest")<
  GreetingServiceTest,
  GreetingServiceTestService
>() {
  static readonly layer = makeGreetingServiceTestLayer();
}
