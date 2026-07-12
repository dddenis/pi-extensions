import { Context, Effect, Layer } from "effect";

export interface EnvironmentService {
  readonly get: (name: string) => Effect.Effect<string | undefined>;
  readonly snapshot: Effect.Effect<Readonly<Record<string, string>>>;
}

const EnvironmentServiceTag = Context.GenericTag<EnvironmentService>(
  "pi-extensions/EnvironmentService",
);

const snapshotProcessEnvironment = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const EnvironmentService = Object.assign(EnvironmentServiceTag, {
  Live: Layer.succeed(EnvironmentServiceTag, {
    get: (name) => Effect.sync(() => process.env[name]),
    snapshot: Effect.sync(snapshotProcessEnvironment),
  } satisfies EnvironmentService),
});
