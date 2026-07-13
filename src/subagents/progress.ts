import { Effect } from "effect";
import { type PiProgressEvent, SAFE_TOOL_PREVIEW } from "./pi-events";
import type { RunUsage } from "./schemas";

export const MAX_PROGRESS_ITEMS = 12;
export const MAX_ASSISTANT_PREVIEW = 240;
export const MAX_TOOL_PREVIEW = 160;

export type ChildLifecycle = "STARTING" | "RUNNING" | "SETTLED";

export type ChildProgressItem =
  | { readonly type: "assistant"; readonly text: string }
  | {
      readonly type: "tool";
      readonly name: string;
      readonly preview: string;
    };

export interface ChildProgress {
  readonly runId: string;
  readonly agent: string;
  readonly lifecycle: ChildLifecycle;
  readonly items: ReadonlyArray<ChildProgressItem>;
  readonly usage: RunUsage;
}

export interface ChildProgressProjector {
  readonly update: (event: PiProgressEvent) => Effect.Effect<void>;
  readonly setLifecycle: (lifecycle: ChildLifecycle) => Effect.Effect<void>;
  readonly snapshot: ChildProgress;
}

const emptyUsage = (): RunUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
});

const truncateCodePoints = (value: string, maximum: number): string =>
  Array.from(value).slice(0, maximum).join("");

const copyItem = (item: ChildProgressItem): ChildProgressItem =>
  item.type === "assistant"
    ? { type: "assistant", text: item.text }
    : { type: "tool", name: item.name, preview: item.preview };

export const makeChildProgress = (
  runId: string,
  agent: string,
): ChildProgressProjector => {
  let lifecycle: ChildLifecycle = "STARTING";
  let items: ReadonlyArray<ChildProgressItem> = [];
  let usage = emptyUsage();

  const appendItem = (item: ChildProgressItem): void => {
    items = [...items, item].slice(-MAX_PROGRESS_ITEMS);
  };

  return {
    update: (event) =>
      Effect.sync(() => {
        switch (event.type) {
          case "session":
            lifecycle = "RUNNING";
            return;
          case "assistant":
            appendItem({
              type: "assistant",
              text: truncateCodePoints(event.text, MAX_ASSISTANT_PREVIEW),
            });
            return;
          case "tool":
            appendItem({
              type: "tool",
              name: event.name,
              preview: truncateCodePoints(SAFE_TOOL_PREVIEW, MAX_TOOL_PREVIEW),
            });
            return;
          case "usage":
            usage = { ...event.usage };
            return;
          case "settled":
            lifecycle = "SETTLED";
            return;
          case "ignored":
            return;
        }
      }),
    setLifecycle: (nextLifecycle) =>
      Effect.sync(() => {
        lifecycle = nextLifecycle;
      }),
    get snapshot(): ChildProgress {
      return {
        runId,
        agent,
        lifecycle,
        items: items.map(copyItem),
        usage: { ...usage },
      };
    },
  };
};
