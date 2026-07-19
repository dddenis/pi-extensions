import { describe, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer } from "effect";
import { expect } from "vitest";
import { makeEffectRunner } from "./effect-runtime";

class RuntimeValue extends Context.Tag("RuntimeValue")<
  RuntimeValue,
  string
>() {}

describe("makeEffectRunner", () => {
  it("runs effects and disposes its managed layer exactly once", async () => {
    let acquisitions = 0;
    let releases = 0;
    const layer = Layer.scoped(
      RuntimeValue,
      Effect.acquireRelease(
        Effect.sync(() => {
          acquisitions += 1;
          return "ready";
        }),
        () =>
          Effect.sync(() => {
            releases += 1;
          }),
      ),
    );
    const runner = makeEffectRunner(layer);

    expect(await runner.runPromise(RuntimeValue)).toBe("ready");
    const fiber = runner.runFork(RuntimeValue);
    expect(await runner.runPromise(Fiber.join(fiber))).toBe("ready");
    expect(acquisitions).toBe(1);

    const firstDispose = runner.dispose();
    const secondDispose = runner.dispose();
    expect(firstDispose).toBe(secondDispose);
    await Promise.all([firstDispose, secondDispose]);
    expect(releases).toBe(1);
  });

  it("forwards AbortSignal and runs interruption finalizers", async () => {
    const runner = makeEffectRunner(Layer.empty);
    const started = Promise.withResolvers<void>();
    let finalizations = 0;
    const controller = new AbortController();

    const running = runner.runPromise(
      Effect.sync(() => started.resolve()).pipe(
        Effect.zipRight(Effect.sleep("50 millis")),
        Effect.as("finished"),
        Effect.ensuring(
          Effect.sync(() => {
            finalizations += 1;
          }),
        ),
      ),
      { signal: controller.signal },
    );

    await started.promise;
    controller.abort();

    await expect(running).rejects.toThrow();
    expect(finalizations).toBe(1);
    await runner.dispose();
  });
});
