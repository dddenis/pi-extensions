import { Context, DateTime, Effect, Layer, Random } from "effect";
import { EnvironmentService } from "../services/environment";
import { FileSystemService } from "../services/file-system";
import { HomeDirectoryService } from "../services/home-directory";
import { ProcessService } from "../services/process";
import {
  type RateLimitReadError,
  readOpenAiRateLimits,
} from "./codex-json-rpc";
import { formatOpenAiRateLimitStatus } from "./rate-limits";

export interface RateLimitReaderService {
  readonly read: Effect.Effect<string, RateLimitReadError>;
}

const RateLimitReaderServiceTag = Context.GenericTag<RateLimitReaderService>(
  "pi-extensions/custom-footer/RateLimitReaderService",
);

const makeRateLimitReader = Effect.gen(function* () {
  const environment = yield* EnvironmentService;
  const fileSystem = yield* FileSystemService;
  const homeDirectory = yield* HomeDirectoryService;
  const processService = yield* ProcessService;

  const read = readOpenAiRateLimits.pipe(
    Effect.provideService(EnvironmentService, environment),
    Effect.provideService(FileSystemService, fileSystem),
    Effect.provideService(HomeDirectoryService, homeDirectory),
    Effect.provideService(ProcessService, processService),
    Effect.flatMap((snapshot) =>
      DateTime.now.pipe(
        Effect.map((now) => formatOpenAiRateLimitStatus(snapshot, now)),
      ),
    ),
  );

  return { read } satisfies RateLimitReaderService;
});

export const RateLimitReaderService = Object.assign(RateLimitReaderServiceTag, {
  Live: Layer.effect(RateLimitReaderServiceTag, makeRateLimitReader),
});

export interface JitterService {
  readonly multiplier: Effect.Effect<number>;
}

const JitterServiceTag = Context.GenericTag<JitterService>(
  "pi-extensions/custom-footer/JitterService",
);

export const JitterService = Object.assign(JitterServiceTag, {
  Live: Layer.succeed(JitterServiceTag, {
    multiplier: Random.next.pipe(Effect.map((value) => 1 + value * 0.25)),
  } satisfies JitterService),
});
