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
});
