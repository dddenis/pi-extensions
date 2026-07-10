import { Context, Effect, Layer } from "effect";

export interface GreetingService {
  readonly greet: (name: string) => Effect.Effect<string>;
}

const GreetingServiceTag =
  Context.GenericTag<GreetingService>("GreetingService");

export const GreetingService = Object.assign(GreetingServiceTag, {
  Live: Layer.succeed(GreetingServiceTag, {
    greet: (name) => Effect.succeed(`Hello, ${name}!`),
  } satisfies GreetingService),
});

export const greet = (
  name: string,
): Effect.Effect<string, never, GreetingService> =>
  Effect.flatMap(GreetingService, (service) => service.greet(name));
