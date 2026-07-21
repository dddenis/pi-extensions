import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeEffectRunner } from "../lib/effect-runtime";
import { EnvironmentService } from "../services/environment";
import { FileSystemError, FileSystemService } from "../services/file-system";
import { HomeDirectoryService } from "../services/home-directory";
import {
  ProcessService,
  type ProcessService as ProcessServiceShape,
} from "../services/process";
import {
  type AttentionHooksRegistrationPort,
  type AttentionHooksSession,
  registerAttentionHooks,
} from "./index";
import type { ObservedExtensionUI } from "./ui-wait-observer";

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
type SessionStartHandler = (session: AttentionHooksSession) => Promise<void>;
type AgentEndHandler = (event: AgentEndEvent) => Promise<void>;
type ControlEventHandler = (payload: unknown) => Promise<void>;

class TestRegistrationPort implements AttentionHooksRegistrationPort {
  private sessionStart: SessionStartHandler = () => Promise.resolve();
  private input: AsyncHandler = () => Promise.resolve();
  private agentStart: AsyncHandler = () => Promise.resolve();
  private agentEnd: AgentEndHandler = () => Promise.resolve();
  private agentSettled: AsyncHandler = () => Promise.resolve();
  private sessionShutdown: AsyncHandler = () => Promise.resolve();
  private readonly controlListeners: Array<{
    active: boolean;
    readonly handler: ControlEventHandler;
  }> = [];
  private readonly customWaitListeners: Array<{
    active: boolean;
    readonly handler: ControlEventHandler;
  }> = [];

  subscribeCount = 0;
  unsubscribeCount = 0;
  customSubscribeCount = 0;
  customUnsubscribeCount = 0;
  private subscribeFailuresRemaining = 0;
  private unsubscribeFailuresRemaining = 0;

  onSessionStart(handler: SessionStartHandler): void {
    this.sessionStart = handler;
  }

  onInput(handler: AsyncHandler): void {
    this.input = handler;
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

  subscribeUserInputWait(handler: ControlEventHandler): () => void {
    const listener = { active: true, handler };
    this.customWaitListeners.push(listener);
    this.customSubscribeCount += 1;
    return () => {
      if (!listener.active) return;
      listener.active = false;
      this.customUnsubscribeCount += 1;
    };
  }

  failNextSubscribe(): void {
    this.subscribeFailuresRemaining += 1;
  }

  failNextUnsubscribe(): void {
    this.unsubscribeFailuresRemaining += 1;
  }

  fireSessionStart(session: AttentionHooksSession): Promise<void> {
    return this.sessionStart(session);
  }

  fireInput(): Promise<void> {
    return this.input();
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

  async emitUserInputWait(payload: unknown): Promise<void> {
    await Promise.all(
      this.customWaitListeners
        .filter((listener) => listener.active)
        .map((listener) => listener.handler(payload)),
    );
  }

  latestControlHandler(): ControlEventHandler | undefined {
    return this.controlListeners.at(-1)?.handler;
  }
}

interface RecordedMarkerTransition {
  readonly operation: "create" | "remove";
  readonly path: string;
}

const markerPath = "/private/tmp/tmux-501/default.tmux-attention-v1-2301-7";

const markerTransition = (
  operation: RecordedMarkerTransition["operation"],
): RecordedMarkerTransition => ({ operation, path: markerPath });

const makeProcessLayer = (
  incrementAudio: () => void,
  incrementRuntimeDispose: () => void,
) =>
  Layer.scoped(
    ProcessService,
    Effect.acquireRelease(
      Effect.succeed<ProcessServiceShape>({
        spawnScoped: () => Effect.die(new Error("unexpected scoped spawn")),
        spawnDetached: () => Effect.sync(incrementAudio),
      }),
      () => Effect.sync(incrementRuntimeDispose),
    ),
  );

interface PendingDialog {
  readonly resolve: (value: string | undefined) => void;
  readonly reject: (error: Error) => void;
}

interface AttentionHooksHarness {
  readonly port: TestRegistrationPort;
  readonly ui: ObservedExtensionUI;
  readonly fireSessionStart: () => Promise<void>;
  readonly markerTransitions: () => ReadonlyArray<RecordedMarkerTransition>;
  readonly resetMarkerTransitions: () => void;
  readonly failNextMarkerOperation: (
    operation: RecordedMarkerTransition["operation"],
  ) => void;
  readonly getAudioSpawnCount: () => number;
  readonly getRuntimeDisposeCount: () => number;
  readonly resolveDialog: (value: string | undefined) => void;
  readonly rejectDialog: (error: Error) => void;
}

interface HarnessOptions {
  readonly childMarker?: string;
}

const makeHarness = async (
  options: HarnessOptions = {},
): Promise<AttentionHooksHarness> => {
  const environment: Record<string, string> = {
    PI_CODING_AGENT_DIR: "/agent",
    TMUX: "/private/tmp/tmux-501/default,2301,0",
    TMUX_PANE: "%7",
    ...(options.childMarker === undefined
      ? {}
      : { PI_SUBAGENT_CHILD: options.childMarker }),
  };
  const recordedMarkerTransitions: Array<RecordedMarkerTransition> = [];
  const markerFailuresRemaining: Record<
    RecordedMarkerTransition["operation"],
    number
  > = { create: 0, remove: 0 };
  let audioSpawnCount = 0;
  let runtimeDisposeCount = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(EnvironmentService, {
      get: (name) => Effect.succeed(environment[name]),
      snapshot: Effect.sync(() => ({ ...environment })),
    }),
    Layer.succeed(HomeDirectoryService, { get: Effect.succeed("/home/me") }),
    Layer.succeed(FileSystemService, {
      exists: () => Effect.succeed(true),
      statMtimeMs: () => Effect.succeed(0),
      readTextFile: () => Effect.succeed(""),
      replaceWithPrivateEmptyFile: (path) =>
        Effect.suspend(() => {
          if (markerFailuresRemaining.create > 0) {
            markerFailuresRemaining.create -= 1;
            return Effect.fail(
              new FileSystemError({
                operation: "replaceWithPrivateEmptyFile",
                path,
                message: "marker creation failed",
              }),
            );
          }
          return Effect.sync(() => {
            recordedMarkerTransitions.push({ operation: "create", path });
          });
        }),
      removeFile: (path) =>
        Effect.suspend(() => {
          if (markerFailuresRemaining.remove > 0) {
            markerFailuresRemaining.remove -= 1;
            return Effect.fail(
              new FileSystemError({
                operation: "removeFile",
                path,
                message: "marker removal failed",
              }),
            );
          }
          return Effect.sync(() => {
            recordedMarkerTransitions.push({ operation: "remove", path });
          });
        }),
    }),
    makeProcessLayer(
      () => {
        audioSpawnCount += 1;
      },
      () => {
        runtimeDisposeCount += 1;
      },
    ),
  );
  const runner = makeEffectRunner(layer);
  const port = new TestRegistrationPort();
  let pendingDialog: PendingDialog | undefined;
  const ui: ObservedExtensionUI = {
    select: () =>
      new Promise<string | undefined>((resolve, reject) => {
        pendingDialog = { resolve, reject };
      }),
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
  };
  const session: AttentionHooksSession = { mode: "tui", ui };
  const fireSessionStart = (): Promise<void> => port.fireSessionStart(session);
  const markerTransitions = (): ReadonlyArray<RecordedMarkerTransition> =>
    recordedMarkerTransitions.map((transition) => ({ ...transition }));
  const resetMarkerTransitions = (): void => {
    recordedMarkerTransitions.length = 0;
  };
  const failNextMarkerOperation = (
    operation: RecordedMarkerTransition["operation"],
  ): void => {
    markerFailuresRemaining[operation] += 1;
  };
  const resolveDialog = (value: string | undefined): void => {
    const current = pendingDialog;
    pendingDialog = undefined;
    if (current === undefined) throw new Error("no pending dialog");
    current.resolve(value);
  };
  const rejectDialog = (error: Error): void => {
    const current = pendingDialog;
    pendingDialog = undefined;
    if (current === undefined) throw new Error("no pending dialog");
    current.reject(error);
  };

  await registerAttentionHooks(port, runner);
  await fireSessionStart();
  resetMarkerTransitions();

  return {
    port,
    ui,
    fireSessionStart,
    markerTransitions,
    resetMarkerTransitions,
    failNextMarkerOperation,
    getAudioSpawnCount: () => audioSpawnCount,
    getRuntimeDisposeCount: () => runtimeDisposeCount,
    resolveDialog,
    rejectDialog,
  };
};

const makeIdleUi = (): ObservedExtensionUI => ({
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  editor: async () => undefined,
});

describe("registerAttentionHooks", () => {
  it("does not play on agent_end alone", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));
    expect(harness.markerTransitions()).toEqual([]);
    expect(harness.getAudioSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("marks only when the latest non-aborted outcome settles", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));
    expect(harness.markerTransitions()).toEqual([]);

    await harness.port.fireAgentSettled();
    expect(harness.markerTransitions()).toEqual([markerTransition("create")]);
    expect(harness.getAudioSpawnCount()).toBe(1);

    await harness.port.fireAgentSettled();
    expect(harness.markerTransitions()).toEqual([markerTransition("create")]);
    await harness.port.fireSessionShutdown();
  });

  it("keeps settled lifecycle and audio independent from marker creation failure", async () => {
    const harness = await makeHarness();
    harness.failNextMarkerOperation("create");
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));

    await expect(harness.port.fireAgentSettled()).resolves.toBeUndefined();
    expect(harness.markerTransitions()).toEqual([]);
    expect(harness.getAudioSpawnCount()).toBe(1);
    await harness.port.fireSessionShutdown();
  });

  it("does not mark aborted or missing outcomes", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("aborted")));
    await harness.port.fireAgentSettled();
    await harness.port.fireAgentSettled();

    expect(harness.markerTransitions()).toEqual([]);
    expect(harness.getAudioSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("uses only the latest retry outcome", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("aborted")));
    await harness.port.fireAgentEnd(agentEnd(assistant("error")));
    await harness.port.fireAgentSettled();
    expect(harness.markerTransitions()).toEqual([markerTransition("create")]);
    expect(harness.getAudioSpawnCount()).toBe(1);
    await harness.port.fireSessionShutdown();
  });

  it("clears a stale outcome on agent_start", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));
    await harness.port.fireAgentStart();
    await harness.port.fireAgentSettled();
    expect(harness.markerTransitions()).toEqual([]);
    expect(harness.getAudioSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("clears passive settled and subagent reasons on later interaction", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("error")));
    await harness.port.fireAgentSettled();
    await harness.port.fireInput();

    await harness.port.emitControlEvent({
      event: { type: "needs_attention" },
    });
    await harness.port.fireAgentStart();

    const transitions = harness.markerTransitions();
    expect(transitions).toEqual([
      markerTransition("create"),
      markerTransition("remove"),
      markerTransition("create"),
      markerTransition("remove"),
    ]);
    expect(transitions.every(({ path }) => path === markerPath)).toBe(true);
    expect(harness.getAudioSpawnCount()).toBe(2);
    await harness.port.fireSessionShutdown();
  });

  it("marks around standard dialogs and clears after success or failure", async () => {
    const harness = await makeHarness();
    const first = harness.ui.select("pick", ["A"]);
    await Promise.resolve();
    expect(harness.markerTransitions()).toEqual([markerTransition("create")]);

    await vi.waitFor(() => harness.resolveDialog("A"), { timeout: 1_000 });
    await expect(first).resolves.toBe("A");
    expect(harness.markerTransitions()).toEqual([
      markerTransition("create"),
      markerTransition("remove"),
    ]);

    const failure = new Error("dialog failed");
    const second = harness.ui.select("pick", ["A"]);
    await Promise.resolve();
    await vi.waitFor(() => harness.rejectDialog(failure), { timeout: 1_000 });
    await expect(second).rejects.toBe(failure);
    expect(harness.markerTransitions()).toEqual([
      markerTransition("create"),
      markerTransition("remove"),
      markerTransition("create"),
      markerTransition("remove"),
    ]);
    await harness.port.fireSessionShutdown();
  });

  it("preserves dialog resolve and reject outcomes when marker operations fail", async () => {
    const harness = await makeHarness();
    harness.failNextMarkerOperation("create");
    harness.failNextMarkerOperation("remove");
    const resolvedDialog = harness.ui.select("pick", ["A"]);
    await Promise.resolve();
    await vi.waitFor(() => harness.resolveDialog("A"), { timeout: 1_000 });

    await expect(resolvedDialog).resolves.toBe("A");
    expect(harness.markerTransitions()).toEqual([]);

    const dialogFailure = new Error("dialog failed");
    harness.failNextMarkerOperation("create");
    harness.failNextMarkerOperation("remove");
    const rejectedDialog = harness.ui.select("pick", ["A"]);
    await Promise.resolve();
    await vi.waitFor(() => harness.rejectDialog(dialogFailure), {
      timeout: 1_000,
    });

    await expect(rejectedDialog).rejects.toBe(dialogFailure);
    expect(harness.markerTransitions()).toEqual([]);
    await harness.port.fireSessionShutdown();
  });

  it("consumes an obsolete passive reason when a dialog begins", async () => {
    const harness = await makeHarness();
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));
    await harness.port.fireAgentSettled();
    harness.resetMarkerTransitions();

    const dialog = harness.ui.select("pick", ["A"]);
    await Promise.resolve();
    expect(harness.markerTransitions()).toEqual([]);
    await vi.waitFor(() => harness.resolveDialog(undefined), {
      timeout: 1_000,
    });
    await dialog;

    expect(harness.markerTransitions()).toEqual([markerTransition("remove")]);
    await harness.port.fireSessionShutdown();
  });

  it("keeps overlap marked until the final standard or custom wait ends", async () => {
    const harness = await makeHarness();
    const dialog = harness.ui.select("pick", ["A"]);
    await Promise.resolve();
    await harness.port.emitUserInputWait({ state: "start", id: "qa:1" });

    harness.resolveDialog("A");
    await dialog;
    expect(harness.markerTransitions()).toEqual([markerTransition("create")]);

    await harness.port.emitUserInputWait({ state: "end", id: "qa:1" });
    expect(harness.markerTransitions()).toEqual([
      markerTransition("create"),
      markerTransition("remove"),
    ]);
    await harness.port.fireSessionShutdown();
  });

  it("treats duplicate, unknown, and malformed custom events as safe", async () => {
    const harness = await makeHarness();
    await harness.port.emitUserInputWait({ state: "end", id: "unknown" });
    await harness.port.emitUserInputWait({ state: "start", id: "qa:1" });
    await harness.port.emitUserInputWait({ state: "start", id: "qa:1" });
    await harness.port.emitUserInputWait({ state: "start", id: "" });
    await harness.port.emitUserInputWait(null);
    await harness.port.emitUserInputWait({ state: "end", id: "qa:1" });
    await harness.port.emitUserInputWait({ state: "end", id: "qa:1" });

    expect(harness.markerTransitions()).toEqual([
      markerTransition("create"),
      markerTransition("remove"),
    ]);
    await harness.port.fireSessionShutdown();
  });

  it("keeps passive attention across a duplicate custom wait start", async () => {
    const harness = await makeHarness();
    await harness.port.emitUserInputWait({ state: "start", id: "qa:1" });
    await harness.port.emitControlEvent({
      event: { type: "needs_attention" },
    });
    await harness.port.emitUserInputWait({ state: "start", id: "qa:1" });
    await harness.port.emitUserInputWait({ state: "end", id: "qa:1" });

    expect(harness.markerTransitions()).toEqual([markerTransition("create")]);
    expect(harness.getAudioSpawnCount()).toBe(1);

    await harness.port.fireInput();
    expect(harness.markerTransitions()).toEqual([
      markerTransition("create"),
      markerTransition("remove"),
    ]);
    await harness.port.fireSessionShutdown();
  });

  it("suppresses completion and control events for the exact child marker", async () => {
    const harness = await makeHarness({ childMarker: "1" });
    await harness.port.fireAgentEnd(agentEnd(assistant("stop")));
    await harness.port.fireAgentSettled();
    await harness.port.emitControlEvent({
      event: { type: "needs_attention" },
    });
    expect(harness.markerTransitions()).toEqual([]);
    expect(harness.getAudioSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("ignores malformed control-event payloads", async () => {
    const harness = await makeHarness();
    await harness.port.emitControlEvent(null);
    await harness.port.emitControlEvent({ event: { type: "other" } });
    await harness.port.emitControlEvent({ event: "needs_attention" });
    expect(harness.markerTransitions()).toEqual([]);
    expect(harness.getAudioSpawnCount()).toBe(0);
    await harness.port.fireSessionShutdown();
  });

  it("replaces listeners and wrappers on repeated session start", async () => {
    const harness = await makeHarness();
    const staleSelect = harness.ui.select;
    await harness.fireSessionStart();
    harness.resetMarkerTransitions();

    expect(harness.port.subscribeCount).toBe(2);
    expect(harness.port.unsubscribeCount).toBe(1);
    expect(harness.port.customSubscribeCount).toBe(2);
    expect(harness.port.customUnsubscribeCount).toBe(1);
    expect(harness.ui.select).not.toBe(staleSelect);

    const staleDialog = staleSelect("stale", ["A"]);
    await Promise.resolve();
    harness.resolveDialog(undefined);
    await staleDialog;
    expect(harness.markerTransitions()).toEqual([]);
    await harness.port.fireSessionShutdown();
  });

  it("reports subscription failure and allows a later session start to retry", async () => {
    const harness = await makeHarness();
    harness.port.failNextSubscribe();

    await expect(harness.fireSessionStart()).rejects.toThrow(
      "subscribe failed",
    );
    expect(harness.port.subscribeCount).toBe(1);
    expect(harness.port.unsubscribeCount).toBe(1);
    expect(harness.port.customSubscribeCount).toBe(1);
    expect(harness.port.customUnsubscribeCount).toBe(1);

    await expect(harness.fireSessionStart()).resolves.toBeUndefined();
    expect(harness.port.subscribeCount).toBe(2);
    expect(harness.port.customSubscribeCount).toBe(2);
    await harness.port.fireSessionShutdown();
  });

  it("installs a new generation and silences the stale listener when replacement unsubscribe throws", async () => {
    const harness = await makeHarness();
    harness.port.failNextUnsubscribe();

    await expect(harness.fireSessionStart()).resolves.toBeUndefined();
    expect(harness.port.subscribeCount).toBe(2);
    expect(harness.port.customSubscribeCount).toBe(2);
    expect(harness.port.customUnsubscribeCount).toBe(1);

    await harness.port.emitControlEvent({
      event: { type: "needs_attention" },
    });
    expect(harness.getAudioSpawnCount()).toBe(1);
    await harness.port.fireSessionShutdown();
  });

  it("unsets, restores observers, and prevents late callbacks on shutdown", async () => {
    const harness = await makeHarness();
    const activeSelect = harness.ui.select;
    await harness.port.emitUserInputWait({ state: "start", id: "qa:1" });
    await harness.port.fireSessionShutdown();
    await harness.port.fireSessionShutdown();

    expect(harness.markerTransitions()).toEqual([
      markerTransition("create"),
      markerTransition("remove"),
    ]);
    expect(harness.port.unsubscribeCount).toBe(1);
    expect(harness.port.customUnsubscribeCount).toBe(1);
    const staleDialog = activeSelect("stale", ["A"]);
    await Promise.resolve();
    harness.resolveDialog(undefined);
    await staleDialog;
    await harness.port.emitControlEvent({
      event: { type: "needs_attention" },
    });
    await harness.port.emitUserInputWait({ state: "start", id: "late" });
    expect(harness.markerTransitions()).toEqual([
      markerTransition("create"),
      markerTransition("remove"),
    ]);
  });

  it("keeps shutdown best-effort and idempotent when marker removal fails", async () => {
    const harness = await makeHarness();
    await harness.port.emitUserInputWait({ state: "start", id: "qa:1" });
    harness.failNextMarkerOperation("remove");

    await expect(harness.port.fireSessionShutdown()).resolves.toBeUndefined();
    await expect(harness.port.fireSessionShutdown()).resolves.toBeUndefined();

    expect(harness.markerTransitions()).toEqual([markerTransition("create")]);
    expect(harness.getRuntimeDisposeCount()).toBe(1);
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
        Layer.succeed(FileSystemService, {
          exists: () => Effect.succeed(false),
          statMtimeMs: () => Effect.succeed(0),
          readTextFile: () => Effect.succeed(""),
          replaceWithPrivateEmptyFile: () => Effect.void,
          removeFile: () => Effect.void,
        }),
        processLayer,
      ),
    );
    const port = new TestRegistrationPort();
    await registerAttentionHooks(port, runner);
    await port.fireSessionStart({ mode: "tui", ui: makeIdleUi() });
    port.failNextUnsubscribe();

    await expect(port.fireSessionShutdown()).resolves.toBeUndefined();
    await expect(port.fireSessionShutdown()).resolves.toBeUndefined();
    expect(port.customUnsubscribeCount).toBe(1);
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
        Layer.succeed(FileSystemService, {
          exists: () => Effect.succeed(true),
          statMtimeMs: () => Effect.succeed(0),
          readTextFile: () => Effect.succeed(""),
          replaceWithPrivateEmptyFile: () => Effect.void,
          removeFile: () => Effect.void,
        }),
        processLayer,
      ),
    );
    const port = new TestRegistrationPort();
    await registerAttentionHooks(port, runner);
    await port.fireSessionStart({ mode: "tui", ui: makeIdleUi() });
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
    expect(port.customUnsubscribeCount).toBe(1);
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
