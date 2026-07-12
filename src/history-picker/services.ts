import {
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { Context, Data, Effect, Layer } from "effect";

export class SessionListingError extends Data.TaggedError(
  "SessionListingError",
)<{
  readonly message: string;
}> {}

export interface SessionListingService {
  readonly listAll: Effect.Effect<
    ReadonlyArray<SessionInfo>,
    SessionListingError
  >;
}

const SessionListingServiceTag = Context.GenericTag<SessionListingService>(
  "pi-extensions/SessionListingService",
);

const copySessionInfo = (session: SessionInfo): SessionInfo => ({
  path: session.path,
  id: session.id,
  cwd: session.cwd,
  ...(session.name === undefined ? {} : { name: session.name }),
  ...(session.parentSessionPath === undefined
    ? {}
    : { parentSessionPath: session.parentSessionPath }),
  created: new Date(session.created.getTime()),
  modified: new Date(session.modified.getTime()),
  messageCount: session.messageCount,
  firstMessage: session.firstMessage,
  allMessagesText: session.allMessagesText,
});

export const copySessionInfos = (
  sessions: ReadonlyArray<SessionInfo>,
): ReadonlyArray<SessionInfo> => sessions.map(copySessionInfo);

export const SessionListingService = Object.assign(SessionListingServiceTag, {
  Live: Layer.succeed(SessionListingServiceTag, {
    // Pi's public API reports some storage problems as a successful empty list.
    // This adapter intentionally cannot distinguish those from a genuinely empty history.
    listAll: Effect.tryPromise({
      try: () => SessionManager.listAll(),
      catch: (cause) =>
        new SessionListingError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.map(copySessionInfos)),
  } satisfies SessionListingService),
});
