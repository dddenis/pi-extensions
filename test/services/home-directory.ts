import { Context, Effect, Layer, Ref } from "effect";
import { HomeDirectoryService } from "../../src/services/home-directory";

export interface HomeDirectoryServiceTestConfig {
  readonly homeDirectory?: string;
}

export type HomeDirectoryServiceTestCall = Readonly<Record<string, never>>;

export interface HomeDirectoryServiceTestState {
  readonly calls: ReadonlyArray<HomeDirectoryServiceTestCall>;
  readonly homeDirectory?: string;
}

interface HomeDirectoryServiceTestInternalState {
  readonly calls: ReadonlyArray<HomeDirectoryServiceTestCall>;
  readonly homeDirectory?: string;
}

export interface HomeDirectoryServiceTestService {
  readonly setHomeDirectory: (homeDirectory: string) => Effect.Effect<void>;
  readonly getState: Effect.Effect<HomeDirectoryServiceTestState>;
  readonly resetCalls: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

type HomeDirectoryServiceTestRef =
  Ref.Ref<HomeDirectoryServiceTestInternalState>;

const makeInitialState = (
  config: HomeDirectoryServiceTestConfig = {},
): HomeDirectoryServiceTestInternalState => ({
  calls: [],
  homeDirectory: config.homeDirectory,
});

const snapshotState = (
  ref: HomeDirectoryServiceTestRef,
): Effect.Effect<HomeDirectoryServiceTestState> =>
  Ref.get(ref).pipe(
    Effect.map((state) => ({
      calls: state.calls.map(() => ({})),
      homeDirectory: state.homeDirectory,
    })),
  );

const makeHomeDirectoryService = (
  ref: HomeDirectoryServiceTestRef,
): HomeDirectoryService => ({
  get: Ref.modify(ref, (state) => [
    state.homeDirectory,
    { ...state, calls: [...state.calls, {}] },
  ]).pipe(
    Effect.flatMap((homeDirectory) =>
      homeDirectory === undefined
        ? Effect.die(
            new Error("HomeDirectoryServiceTest.get is not configured"),
          )
        : Effect.succeed(homeDirectory),
    ),
  ),
});

const makeHomeDirectoryServiceTest = (
  ref: HomeDirectoryServiceTestRef,
  initialConfig: HomeDirectoryServiceTestConfig,
): HomeDirectoryServiceTestService => ({
  setHomeDirectory: (homeDirectory) =>
    Ref.update(ref, (state) => ({ ...state, homeDirectory })),
  getState: snapshotState(ref),
  resetCalls: Ref.update(ref, (state) => ({ ...state, calls: [] })),
  reset: Ref.set(ref, makeInitialState(initialConfig)),
});

const makeHomeDirectoryServiceTestLayer = (
  config: HomeDirectoryServiceTestConfig = {},
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const initialConfig = { ...config };
      const ref = yield* Ref.make(makeInitialState(initialConfig));
      const controls = makeHomeDirectoryServiceTest(ref, initialConfig);
      const fake = makeHomeDirectoryService(ref);

      return Context.add(
        Context.make(HomeDirectoryService, fake),
        HomeDirectoryServiceTest,
        controls,
      );
    }),
  );

export class HomeDirectoryServiceTest extends Context.Tag(
  "HomeDirectoryServiceTest",
)<HomeDirectoryServiceTest, HomeDirectoryServiceTestService>() {
  static readonly layer = makeHomeDirectoryServiceTestLayer;
}
