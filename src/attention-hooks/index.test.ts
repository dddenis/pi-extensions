import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeEffectRunner } from "../lib/effect-runtime";
import { EnvironmentService } from "../services/environment";
import {
  FileSystemService,
  type FileSystemService as FileSystemServiceShape,
} from "../services/file-system";
import { HomeDirectoryService } from "../services/home-directory";
import {
  ProcessService,
  type ProcessService as ProcessServiceShape,
} from "../services/process";
import {
  type AttentionHooksRegistrationPort,
  registerAttentionHooks,
} from "./index";

const makeFileSystemStub = (pathExists: boolean): FileSystemServiceShape => ({
  exists: () => Effect.succeed(pathExists),
  statMtimeMs: () => Effect.succeed(0),
  stat: () => Effect.die(new Error("unexpected stat")),
  readDirectory: () => Effect.die(new Error("unexpected readDirectory")),
  readTextFile: () => Effect.succeed(""),
  makeDirectory: () => Effect.die(new Error("unexpected makeDirectory")),
  writeTextFile: () => Effect.die(new Error("unexpected writeTextFile")),
  appendTextFile: () => Effect.die(new Error("unexpected appendTextFile")),
  realPath: () => Effect.die(new Error("unexpected realPath")),
  rename: () => Effect.die(new Error("unexpected rename")),
  remove: () => Effect.die(new Error("unexpected remove")),
});

const assistant = (
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "test",
  provider: "test",
  model: "test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 0,
});

const agentEnd = (...messages: AgentEndEvent["messages"]): AgentEndEvent => ({
  type: "agent_end",
  messages,
});

type AsyncHandler = () => Promise<void>;
type AgentEndHandler = (event: AgentEndEvent) => Promise<void>;
type ControlEventHandler = (payload: unknown) => Promise<void>;

class TestRegistrationPort implements AttentionHooksRegistrationPort {
  private sessionStart: AsyncHandler = () => Promise.resolve();
  private agentStart: AsyncHandler = () => Promise.resolve();
  private agentEnd: AgentEndHandler = () => Promise.resolve();
  private agentSettled: AsyncHandler = () => Promise.resolve();
  private sessionShutdown: AsyncHandler = () => Promise.resolve();
  private readonly controlListeners: Array<{
    active: boolean;
    readonly handler: ControlEventHandler;
  }> = [];

  subscribeCount = 0;
  unsubscribeCount = 0;
  private subscribeFailuresRemaining = 0;
  private unsubscribeFailuresRemaining = 0;

  onSessionStart(handler: AsyncHandler): void {
    this.sessionStart = handler;
  }

  onAgentStart(handler: AsyncHandler): void {
    this.agentStart = handler;
  }

  onAgentEnd(handler: AgentEndHandler): void {
    this.agentEnd = handler;
  }

  onAgentSettled(handler: AsyncHandler): void {
    this.agentSettled = handler;
  }

  onSessionShutdown(handler: AsyncHandler): void {
    this.sessionShutdown = handler;
  }

  subscribeControlEvent(handler: ControlEventHandler): () => void {
    if (this.subscribeFailuresRemaining > 0) {
      this.subscribeFailuresRemaining -= 1;
      throw new Error("subscribe failed");
    }
    const listener = { active: true, handler };
    this.controlListeners.push(listener);
    this.subscribeCount += 1;
    return () => {
      if (!listener.active) return;
      if (this.unsubscribeFailuresRemaining > 0) {
        this.unsubscribeFailuresRemaining -= 1;
        throw new Error("unsubscribe failed");
      }
      listener.active = false;
      this.unsubscribeCount += 1;
    };
  }

  failNextSubscribe(): void {
    this.subscribeFailuresRemaining += 1;
  }

  failNextUnsubscribe(): void {
    this.unsubscribeFailuresRemaining += 1;
  }

  fireSessionStart(): Promise<void> {
    return this.sessionStart();
  }

  fireAgentStart(): Promise<void> {
    return this.agentStart();
  }

  fireAgentEnd(event: AgentEndEvent): Promise<void> {
    return this.agentEnd(event);
  }

  fireAgentSettled(): Promise<void> {
    return this.agentSettled();
  }

  fireSessionShutdown(): Promise<void> {
    return this.sessionShutdown();
  }

  async emitControlEvent(payload: unknown): Promise<void> {
    await Promise.all(
      this.controlListeners
        .filter((listener) => listener.active)
        .map((listener) => listener.handler(payload)),
    );
  }

  latestControlHandler(): ControlEventHandler | undefined {
    return this.controlListeners.at(-1)?.handler;
  }
}

const makeHarness = async () => {
  const environment: Record<string, string> = {
    PI_CODING_AGENT_DIR: "/agent",
  };
  let spawnCount = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(EnvironmentService, {
      get: (name) => Effect.succeed(environment[name]),
      snapshot: Effect.sync(() => ({ ...environment })),
    }),
    Layer.succeed(HomeDirectoryService, { get: Effect.succeed("/home/me") }),
    Layer.succeed(FileSystemService, makeFileSystemStub(true)),
    Layer.succeed(ProcessService, {
      spawnScoped: () => Effect.die(new Error("unexpected scoped spawn")),
      spawnDetached: () =>
        Effect.sync(() => {
          spawnCount += 1;
        }),
    } satisfies ProcessServiceShape),
  );
  const runner = makeEffectRunner(layer);
  const port = new TestRegistrationPort();
  await registerAttentionHooks(port, runner);

  return {
    port,
    getSpawnCount: () => spawnCount,
    setChildMarker: (value: string | undefined) => {
      if (value === undefined) {
        delete environment.PI_SUBAGENT_CHILD;
      } else {
        environment.PI_SUBAGENT_CHILD = value;
      }
    },
  };
};

describe("registerAttentionHooks", () => {
  it("does not play on agent_end alone", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));
    expect(harness.getSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("plays once only after a non-aborted outcome settles", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));
    await harness.port.fireAgentSettled();
    expect(harness.getSpawnCount()).toBe(1);

    await harness.port.fireAgentSettled();
    expect(harness.getSpawnCount()).toBe(1);
    await harness.port.fireSessionShutdown();
  });

  it("does not play for an aborted final outcome", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("aborted")));
    await harness.port.fireAgentSettled();
    expect(harness.getSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("uses only the latest retry outcome", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("aborted")));
    await harness.port.fireAgentEnd(agentEnd(assistant("error")));
    await harness.port.fireAgentSettled();
    expect(harness.getSpawnCount()).toBe(1);
    await harness.port.fireSessionShutdown();
  });

  it("clears a stale outcome on agent_start", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));
    await harness.port.fireAgentStart();
    await harness.port.fireAgentSettled();
    expect(harness.getSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("suppresses completion and control events for the exact child marker", async () => {
    const harness = await makeHarness();
    harness.setChildMarker("1");
    await harness.port.fireSessionStart();
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));
    await harness.port.fireAgentSettled();
    await harness.port.emitControlEvent({
      event: { type: "needs_attention" },
    });
    expect(harness.getSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("ignores malformed control-event payloads", async () => {
    const harness = await makeHarness();
    await harness.port.fireSessionStart();
    await harness.port.emitControlEvent(null);
    await harness.port.emitControlEvent({ event: { type: "other" } });
    await harness.port.emitControlEvent({ event: "needs_attention" });
    expect(harness.getSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("replaces and unsubscribes the control listener on repeated session start", async () => {
    const harness = await makeHarness();
    await harness.port.fireSessionStart();
    await harness.port.fireSessionStart();
    expect(harness.port.subscribeCount).toBe(2);
    expect(harness.port.unsubscribeCount).toBe(1);

    await harness.port.emitControlEvent({
      event: { type: "needs_attention" },
    });
    expect(harness.getSpawnCount()).toBe(1);
    await harness.port.fireSessionShutdown();
    expect(harness.port.unsubscribeCount).toBe(2);
  });

  it("reports subscription failure and allows a later session start to retry", async () => {
    const harness = await makeHarness();
    harness.port.failNextSubscribe();

    await expect(harness.port.fireSessionStart()).rejects.toThrow(
      "subscribe failed",
    );
    expect(harness.port.subscribeCount).toBe(0);

    await expect(harness.port.fireSessionStart()).resolves.toBeUndefined();
    expect(harness.port.subscribeCount).toBe(1);
    await harness.port.fireSessionShutdown();
  });

  it("installs a new generation and silences the stale listener when replacement unsubscribe throws", async () => {
    const harness = await makeHarness();
    await harness.port.fireSessionStart();
    harness.port.failNextUnsubscribe();

    await expect(harness.port.fireSessionStart()).resolves.toBeUndefined();
    expect(harness.port.subscribeCount).toBe(2);

    await harness.port.emitControlEvent({
      event: { type: "needs_attention" },
    });
    expect(harness.getSpawnCount()).toBe(1);
    await harness.port.fireSessionShutdown();
  });

  it("unsubscribes once and prevents later playback on idempotent shutdown", async () => {
    const harness = await makeHarness();
    await harness.port.fireSessionStart();
    await harness.port.fireSessionShutdown();
    await harness.port.fireSessionShutdown();
    expect(harness.port.unsubscribeCount).toBe(1);

    await harness.port.emitControlEvent({
      event: { type: "needs_attention" },
    });
    expect(harness.getSpawnCount()).toBe(0);
  });

  it("disposes the runtime when shutdown unsubscribe throws", async () => {
    const events: Array<string> = [];
    const processLayer = Layer.scoped(
      ProcessService,
      Effect.acquireRelease(
        Effect.succeed<ProcessServiceShape>({
          spawnScoped: () => Effect.die(new Error("unexpected scoped spawn")),
          spawnDetached: () => Effect.void,
        }),
        () =>
          Effect.sync(() => {
            events.push("disposed");
          }),
      ),
    );
    const runner = makeEffectRunner(
      Layer.mergeAll(
        Layer.succeed(EnvironmentService, {
          get: () => Effect.sync((): string | undefined => undefined),
          snapshot: Effect.succeed({}),
        }),
        Layer.succeed(HomeDirectoryService, {
          get: Effect.succeed("/home/me"),
        }),
        Layer.succeed(FileSystemService, makeFileSystemStub(false)),
        processLayer,
      ),
    );
    const port = new TestRegistrationPort();
    await registerAttentionHooks(port, runner);
    await port.fireSessionStart();
    port.failNextUnsubscribe();

    await expect(port.fireSessionShutdown()).resolves.toBeUndefined();
    await expect(port.fireSessionShutdown()).resolves.toBeUndefined();
    expect(events).toEqual(["disposed"]);
  });

  it("interrupts and joins retained listener work before disposing when unsubscribe throws", async () => {
    const events: Array<string> = [];
    let spawnCount = 0;
    let resolvePlaybackActive: () => void = () => undefined;
    const playbackActive = new Promise<void>((resolve) => {
      resolvePlaybackActive = resolve;
    });
    const processLayer = Layer.scoped(
      ProcessService,
      Effect.acquireRelease(
        Effect.succeed<ProcessServiceShape>({
          spawnScoped: () => Effect.die(new Error("unexpected scoped spawn")),
          spawnDetached: () =>
            Effect.sync(() => {
              spawnCount += 1;
              events.push("playback-active");
              resolvePlaybackActive();
            }).pipe(
              Effect.zipRight(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  events.push("playback-interrupted");
                }),
              ),
            ),
        }),
        () =>
          Effect.sync(() => {
            events.push("disposed");
          }),
      ),
    );
    const runner = makeEffectRunner(
      Layer.mergeAll(
        Layer.succeed(EnvironmentService, {
          get: (name) =>
            Effect.succeed(
              name === "PI_CODING_AGENT_DIR" ? "/agent" : undefined,
            ),
          snapshot: Effect.succeed({ PI_CODING_AGENT_DIR: "/agent" }),
        }),
        Layer.succeed(HomeDirectoryService, {
          get: Effect.succeed("/home/me"),
        }),
        Layer.succeed(FileSystemService, makeFileSystemStub(true)),
        processLayer,
      ),
    );
    const port = new TestRegistrationPort();
    await registerAttentionHooks(port, runner);
    await port.fireSessionStart();
    const staleHandler = port.latestControlHandler();
    if (staleHandler === undefined) {
      throw new Error("session start did not retain a control handler");
    }

    const playback = staleHandler({ event: { type: "needs_attention" } });
    await playbackActive;
    port.failNextUnsubscribe();
    const shutdown = port.fireSessionShutdown();
    await Promise.all([playback, shutdown]);

    expect(port.unsubscribeCount).toBe(0);
    expect(events).toEqual([
      "playback-active",
      "playback-interrupted",
      "disposed",
    ]);
    expect(spawnCount).toBe(1);

    await staleHandler({ event: { type: "needs_attention" } });
    await port.fireSessionShutdown();
    expect(spawnCount).toBe(1);
    expect(port.unsubscribeCount).toBe(0);
    expect(events.filter((event) => event === "disposed")).toHaveLength(1);
  });
});
