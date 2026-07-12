import { ManagedRuntime, type Effect, type Layer } from "effect";

export const makeEffectRunner = <R, E>(layer: Layer.Layer<R, E, never>) => {
  const runtime = ManagedRuntime.make(layer);
  let disposal: Promise<void> | undefined;

  return {
    runPromise: <A, E2>(effect: Effect.Effect<A, E2, R>): Promise<A> =>
      runtime.runPromise(effect),
    runFork: <A, E2>(effect: Effect.Effect<A, E2, R>) =>
      runtime.runFork(effect),
    dispose: (): Promise<void> => {
      disposal ??= runtime.dispose();
      return disposal;
    },
  };
};
