import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  makeChildProgress,
  MAX_ASSISTANT_PREVIEW,
  MAX_PROGRESS_ITEMS,
  MAX_TOOL_PREVIEW,
} from "./progress";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

describe("ChildProgress projection", () => {
  it("exports the fixed progress bounds", () => {
    expect(MAX_PROGRESS_ITEMS).toBe(12);
    expect(MAX_ASSISTANT_PREVIEW).toBe(240);
    expect(MAX_TOOL_PREVIEW).toBe(160);
  });

  it.effect("tracks run identity, lifecycle, and aggregate usage", () =>
    Effect.gen(function* () {
      const progress = makeChildProgress("run-1", "alpha");
      expect(progress.snapshot).toEqual({
        runId: "run-1",
        agent: "alpha",
        lifecycle: "STARTING",
        items: [],
        usage: zeroUsage,
      });

      yield* progress.update({ type: "session", sessionId: "session-1" });
      yield* progress.update({
        type: "usage",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 5,
          cacheWrite: 7,
          cost: 1.25,
          turns: 1,
        },
      });
      yield* progress.update({ type: "settled" });

      expect(progress.snapshot).toMatchObject({
        lifecycle: "SETTLED",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 5,
          cacheWrite: 7,
          cost: 1.25,
          turns: 1,
        },
      });
    }),
  );

  it.effect("truncates assistant previews by Unicode code points", () =>
    Effect.gen(function* () {
      const progress = makeChildProgress("run-1", "beta");
      const text = `${"😀".repeat(MAX_ASSISTANT_PREVIEW)}tail`;
      yield* progress.update({ type: "assistant", text });

      const snapshot = progress.snapshot;
      expect(snapshot.items).toEqual([
        { type: "assistant", text: "😀".repeat(MAX_ASSISTANT_PREVIEW) },
      ]);
      const item = snapshot.items[0];
      expect(
        item?.type === "assistant" ? Array.from(item.text).length : 0,
      ).toBe(MAX_ASSISTANT_PREVIEW);
    }),
  );

  it.effect(
    "replaces arbitrary tool previews with a non-sensitive summary",
    () =>
      Effect.gen(function* () {
        const progress = makeChildProgress("run-1", "beta");
        yield* progress.update({
          type: "tool",
          name: "read",
          preview:
            "short-secret-token /private/customer.txt publish private prompt",
        });

        expect(progress.snapshot.items).toEqual([
          { type: "tool", name: "read", preview: "started" },
        ]);
        const serialized = JSON.stringify(progress.snapshot);
        expect(serialized).not.toContain("short-secret-token");
        expect(serialized).not.toContain("/private/customer.txt");
        expect(serialized).not.toContain("private prompt");
      }),
  );

  it.effect("retains only the latest twelve bounded items", () =>
    Effect.gen(function* () {
      const progress = makeChildProgress("run-1", "beta");
      for (let index = 0; index < MAX_PROGRESS_ITEMS + 3; index += 1) {
        yield* progress.update({ type: "assistant", text: `item-${index}` });
      }

      const snapshot = progress.snapshot;
      expect(snapshot.items).toHaveLength(MAX_PROGRESS_ITEMS);
      expect(snapshot.items[0]).toEqual({ type: "assistant", text: "item-3" });
      expect(snapshot.items[MAX_PROGRESS_ITEMS - 1]).toEqual({
        type: "assistant",
        text: "item-14",
      });
    }),
  );

  it.effect("copies item arrays and usage objects on every snapshot", () =>
    Effect.gen(function* () {
      const progress = makeChildProgress("run-1", "beta");
      yield* progress.update({ type: "assistant", text: "working" });

      const first = progress.snapshot;
      const second = progress.snapshot;
      expect(first).not.toBe(second);
      expect(first.items).not.toBe(second.items);
      expect(first.items[0]).not.toBe(second.items[0]);
      expect(first.usage).not.toBe(second.usage);
      expect(first).toEqual(second);
    }),
  );

  it.effect(
    "does not retain ignored raw JSON or text beyond preview bounds",
    () =>
      Effect.gen(function* () {
        const progress = makeChildProgress("run-1", "beta");
        yield* progress.update({ type: "ignored" });
        yield* progress.update({
          type: "tool",
          name: "bash",
          preview: "FULL_TOOL_RESULT_SECRET",
        });

        const serialized = JSON.stringify(progress.snapshot);
        expect(serialized).not.toContain("FULL_TOOL_RESULT_SECRET");
        expect(serialized).not.toContain("rawLine");
        expect(serialized).not.toContain("session-1");
      }),
  );

  it.effect("allows the executor to project an explicit lifecycle", () =>
    Effect.gen(function* () {
      const progress = makeChildProgress("run-1", "beta");
      yield* progress.setLifecycle("RUNNING");
      expect(progress.snapshot.lifecycle).toBe("RUNNING");
    }),
  );
});
