import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect } from "vitest";
import {
  EnvironmentServiceTest,
  FileSystemServiceTest,
  HomeDirectoryServiceTest,
  ProcessServiceTest,
} from "../../test/services";
import { resolveAgentDirectoryEffect } from "../lib/agent-directory";
import {
  ProcessError,
  ProcessService,
  type ProcessService as ProcessServiceShape,
} from "../services/process";
import {
  ATTENTION_SOUND_FILE,
  completionShouldNotify,
  isNeedsAttention,
  playAttentionSound,
} from "./notification";

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

const testLayer = (
  agentDirectory: string | undefined,
  homeDirectory: string,
  soundPath: string,
  exists: boolean,
) =>
  Layer.mergeAll(
    EnvironmentServiceTest.layer({
      values:
        agentDirectory === undefined
          ? {}
          : { PI_CODING_AGENT_DIR: agentDirectory },
    }),
    HomeDirectoryServiceTest.layer({ homeDirectory }),
    FileSystemServiceTest.layer({ exists: new Map([[soundPath, exists]]) }),
    ProcessServiceTest.layer(),
  );

const processLayer = (spawnDetached: ProcessServiceShape["spawnDetached"]) =>
  Layer.succeed(ProcessService, {
    spawnScoped: () => Effect.die(new Error("unexpected scoped spawn")),
    spawnDetached,
  } satisfies ProcessServiceShape);

describe("attention notification decisions", () => {
  it("uses the final assistant outcome", () => {
    expect(completionShouldNotify([assistant("stop")])).toBe(true);
    expect(completionShouldNotify([assistant("error")])).toBe(true);
    expect(
      completionShouldNotify([assistant("stop"), assistant("aborted")]),
    ).toBe(false);
    expect(completionShouldNotify([])).toBe(false);
  });

  it("validates needs-attention bus payloads", () => {
    expect(isNeedsAttention({ event: { type: "needs_attention" } })).toBe(true);
    expect(isNeedsAttention({ event: { type: "other" } })).toBe(false);
    expect(isNeedsAttention(null)).toBe(false);
  });
});

describe("playAttentionSound", () => {
  it.effect("resolves and plays the exact default sound path", () => {
    const soundPath = path.join("/home/me/.pi/agent", ATTENTION_SOUND_FILE);
    const layer = testLayer(undefined, "/home/me", soundPath, true);

    return Effect.gen(function* () {
      yield* playAttentionSound;
      const processes = yield* ProcessServiceTest;
      const processState = yield* processes.getState;
      expect(processState.calls).toEqual([
        {
          command: "afplay",
          args: [
            "/home/me/.pi/agent/vittemacop-alert-notification-pop-cartoon-bubble-pop-pop-up-478078.mp3",
          ],
          options: { detached: true, stdio: "ignore" },
        },
      ]);
      expect(processState.detachedSpawnCount).toBe(1);
      expect(processState.unrefCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves and plays the exact configured sound path", () => {
    const soundPath = path.join("/agent", ATTENTION_SOUND_FILE);
    const layer = testLayer("/agent", "/home/me", soundPath, true);

    return Effect.gen(function* () {
      yield* playAttentionSound;
      expect(yield* resolveAgentDirectoryEffect).toBe("/agent");
      const processes = yield* ProcessServiceTest;
      const processState = yield* processes.getState;
      expect(processState.calls).toEqual([
        {
          command: "afplay",
          args: [
            "/agent/vittemacop-alert-notification-pop-cartoon-bubble-pop-pop-up-478078.mp3",
          ],
          options: { detached: true, stdio: "ignore" },
        },
      ]);
      expect(processState.unrefCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not spawn when the sound file is absent", () => {
    const soundPath = path.join("/agent", ATTENTION_SOUND_FILE);
    const layer = testLayer("/agent", "/home/me", soundPath, false);

    return Effect.gen(function* () {
      yield* playAttentionSound;
      const processes = yield* ProcessServiceTest;
      expect((yield* processes.getState).calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("suppresses only the exact child marker", () => {
    const soundPath = path.join("/agent", ATTENTION_SOUND_FILE);
    const layer = testLayer("/agent", "/home/me", soundPath, true);

    return Effect.gen(function* () {
      const environment = yield* EnvironmentServiceTest;
      yield* environment.setValues({
        PI_CODING_AGENT_DIR: "/agent",
        PI_SUBAGENT_CHILD: "1",
      });
      yield* playAttentionSound;
      const processes = yield* ProcessServiceTest;
      expect((yield* processes.getState).calls).toEqual([]);

      yield* environment.setValues({
        PI_CODING_AGENT_DIR: "/agent",
        PI_SUBAGENT_CHILD: "true",
      });
      yield* playAttentionSound;
      expect((yield* processes.getState).calls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps detached spawn failures best-effort", () => {
    const soundPath = path.join("/agent", ATTENTION_SOUND_FILE);
    const baseLayer = Layer.mergeAll(
      EnvironmentServiceTest.layer({
        values: { PI_CODING_AGENT_DIR: "/agent" },
      }),
      HomeDirectoryServiceTest.layer({ homeDirectory: "/home/me" }),
      FileSystemServiceTest.layer({
        exists: new Map([[soundPath, true]]),
      }),
    );
    const spawnError = new ProcessError({
      operation: "spawn",
      message: "spawn failed",
    });
    const spawnFailureLayer = Layer.merge(
      baseLayer,
      processLayer(() => Effect.fail(spawnError)),
    );

    return Effect.gen(function* () {
      expect(
        yield* Effect.exit(
          playAttentionSound.pipe(Effect.provide(spawnFailureLayer)),
        ),
      ).toMatchObject({ _tag: "Success" });
    });
  });

  it.effect(
    "stays successful when detached spawn fails during active playback",
    () =>
      Effect.gen(function* () {
        const soundPath = path.join("/agent", ATTENTION_SOUND_FILE);
        const spawnStarted = yield* Deferred.make<void>();
        const releaseSpawn = yield* Deferred.make<void>();
        const spawnError = new ProcessError({
          operation: "spawn",
          message: "asynchronous child error",
        });
        const causalLayer = Layer.mergeAll(
          EnvironmentServiceTest.layer({
            values: { PI_CODING_AGENT_DIR: "/agent" },
          }),
          HomeDirectoryServiceTest.layer({ homeDirectory: "/home/me" }),
          FileSystemServiceTest.layer({
            exists: new Map([[soundPath, true]]),
          }),
          processLayer(() =>
            Deferred.succeed(spawnStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseSpawn)),
              Effect.zipRight(Effect.fail(spawnError)),
            ),
          ),
        );

        const playback = yield* Effect.fork(
          playAttentionSound.pipe(Effect.provide(causalLayer)),
        );
        yield* Deferred.await(spawnStarted);
        yield* Deferred.succeed(releaseSpawn, undefined);

        expect(yield* Fiber.join(playback)).toBeUndefined();
      }),
  );
});
