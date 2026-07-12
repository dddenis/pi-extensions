import path from "node:path";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { resolveAgentDirectoryEffect } from "../lib/agent-directory";
import { EnvironmentService } from "../services/environment";
import { FileSystemService } from "../services/file-system";
import { ProcessService } from "../services/process";

export const ATTENTION_SOUND_FILE =
  "vittemacop-alert-notification-pop-cartoon-bubble-pop-pop-up-478078.mp3";

const NeedsAttentionPayload = Schema.Struct({
  event: Schema.Struct({ type: Schema.Literal("needs_attention") }),
});

export const isNeedsAttention = Schema.is(NeedsAttentionPayload);

export const completionShouldNotify = (
  messages: AgentEndEvent["messages"],
): boolean => {
  const assistant = messages.findLast(
    (message) => message.role === "assistant",
  );
  return assistant !== undefined && assistant.stopReason !== "aborted";
};

export const playAttentionSound = Effect.gen(function* () {
  const environment = yield* EnvironmentService;
  if ((yield* environment.get("PI_SUBAGENT_CHILD")) === "1") return;

  const fileSystem = yield* FileSystemService;
  const process = yield* ProcessService;
  const soundPath = path.join(
    yield* resolveAgentDirectoryEffect,
    ATTENTION_SOUND_FILE,
  );
  if (!(yield* fileSystem.exists(soundPath))) return;

  yield* process.spawnDetached("afplay", [soundPath], {});
}).pipe(Effect.catchAllCause(() => Effect.void));
