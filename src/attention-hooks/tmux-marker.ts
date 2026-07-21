import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Option, Ref, Schema } from "effect";
import { EnvironmentService } from "../services/environment";
import {
  FileSystemService,
  type FileSystemService as FileSystemServiceShape,
} from "../services/file-system";

type ExtensionMode = ExtensionContext["mode"];

const protocol = "tmux-attention-v1";
const AsciiDecimal = Schema.String.pipe(Schema.pattern(/^[0-9]+$/));
const PaneId = Schema.String.pipe(Schema.pattern(/^%[0-9]+$/));
const isAsciiDecimal = Schema.is(AsciiDecimal);
const isPaneId = Schema.is(PaneId);

const markerPathFrom = (
  tmux: string,
  paneId: string,
): Option.Option<string> => {
  const sessionSeparator = tmux.lastIndexOf(",");
  if (sessionSeparator < 0) return Option.none();
  const pidSeparator = tmux.lastIndexOf(",", sessionSeparator - 1);
  if (pidSeparator < 0) return Option.none();

  const socketPath = tmux.slice(0, pidSeparator);
  const serverPid = tmux.slice(pidSeparator + 1, sessionSeparator);
  const sessionId = tmux.slice(sessionSeparator + 1);
  if (
    socketPath.length === 0 ||
    !isAsciiDecimal(serverPid) ||
    !isAsciiDecimal(sessionId) ||
    !isPaneId(paneId)
  ) {
    return Option.none();
  }

  return Option.some(
    `${socketPath}.${protocol}-${serverPid}-${paneId.slice(1)}`,
  );
};

export interface TmuxMarker {
  readonly interactiveRoot: boolean;
  readonly setWaiting: (waiting: boolean) => Effect.Effect<void>;
}

const disabledMarker = (interactiveRoot: boolean): TmuxMarker => ({
  interactiveRoot,
  setWaiting: () => Effect.void,
});

const runTransition = (
  fileSystem: FileSystemServiceShape,
  markerPath: string,
  waiting: boolean,
): Effect.Effect<boolean> =>
  (waiting
    ? fileSystem.replaceWithPrivateEmptyFile(markerPath)
    : fileSystem.removeFile(markerPath)
  ).pipe(
    Effect.as(true),
    Effect.catchAllCause(() => Effect.succeed(false)),
  );

export const makeTmuxMarker = (
  mode: ExtensionMode,
): Effect.Effect<TmuxMarker, never, EnvironmentService | FileSystemService> =>
  Effect.gen(function* () {
    const environment = yield* EnvironmentService;
    const fileSystem = yield* FileSystemService;
    const childMarker = yield* environment.get("PI_SUBAGENT_CHILD");
    const interactiveRoot = mode === "tui" && childMarker !== "1";
    if (!interactiveRoot) return disabledMarker(false);

    const tmux = yield* environment.get("TMUX");
    const paneId = yield* environment.get("TMUX_PANE");
    if (tmux === undefined || paneId === undefined) {
      return disabledMarker(true);
    }
    const markerPath = markerPathFrom(tmux, paneId);
    if (Option.isNone(markerPath)) {
      return disabledMarker(true);
    }

    const desired = yield* Ref.make(false);
    const applied = yield* Ref.make<Option.Option<boolean>>(Option.none());
    const mutex = yield* Effect.makeSemaphore(1);

    const reconcile = mutex.withPermits(1)(
      Effect.gen(function* () {
        while (true) {
          const target = yield* Ref.get(desired);
          const current = yield* Ref.get(applied);
          if (Option.isSome(current) && current.value === target) return;

          yield* Effect.gen(function* () {
            const succeeded = yield* runTransition(
              fileSystem,
              markerPath.value,
              target,
            );
            yield* Ref.set(
              applied,
              succeeded ? Option.some(target) : Option.none(),
            );
          }).pipe(Effect.uninterruptible);

          const latest = yield* Ref.get(desired);
          if (latest === target) return;
        }
      }),
    );

    return {
      interactiveRoot: true,
      setWaiting: (waiting) =>
        Ref.set(desired, waiting).pipe(
          Effect.zipRight(reconcile),
          Effect.catchAllCause(() => Effect.void),
        ),
    } satisfies TmuxMarker;
  }).pipe(Effect.catchAllCause(() => Effect.succeed(disabledMarker(false))));
