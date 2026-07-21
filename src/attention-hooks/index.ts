import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Data,
  Effect,
  ExecutionStrategy,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
} from "effect";
import { makeEffectRunner } from "../lib/effect-runtime";
import { EnvironmentService } from "../services/environment";
import { FileSystemService } from "../services/file-system";
import { HomeDirectoryService } from "../services/home-directory";
import { ProcessService } from "../services/process";
import {
  completionShouldNotify,
  isNeedsAttention,
  playAttentionSound,
} from "./notification";
import { makeTmuxMarker, type TmuxMarker } from "./tmux-marker";
import {
  installUiWaitObserver,
  isUserInputWaitEvent,
  type ObservedExtensionUI,
  type StandardWaitToken,
} from "./ui-wait-observer";

type ExtensionMode = ExtensionContext["mode"];

type AttentionHooksDependencies =
  | EnvironmentService
  | FileSystemService
  | HomeDirectoryService
  | ProcessService;

type AsyncHandler = () => Promise<void>;
type AgentEndHandler = (event: AgentEndEvent) => Promise<void>;
type ControlEventHandler = (payload: unknown) => Promise<void>;
type EventSubscription = (handler: ControlEventHandler) => () => void;

export interface AttentionHooksSession {
  readonly mode: ExtensionMode;
  readonly ui: ObservedExtensionUI;
}

export interface AttentionHooksRegistrationPort {
  readonly onSessionStart: (
    handler: (session: AttentionHooksSession) => Promise<void>,
  ) => void;
  readonly onInput: (handler: AsyncHandler) => void;
  readonly onAgentStart: (handler: AsyncHandler) => void;
  readonly onAgentEnd: (handler: AgentEndHandler) => void;
  readonly onAgentSettled: (handler: AsyncHandler) => void;
  readonly onSessionShutdown: (handler: AsyncHandler) => void;
  readonly subscribeControlEvent: (handler: ControlEventHandler) => () => void;
  readonly subscribeUserInputWait: (handler: ControlEventHandler) => () => void;
}

export interface AttentionHooksRunner {
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, AttentionHooksDependencies>,
  ) => Promise<A>;
  readonly dispose: () => Promise<void>;
}

interface GenerationToken {
  active: boolean;
}

interface AttentionReasons {
  readonly settledRun: boolean;
  readonly subagent: boolean;
  readonly standardWaits: ReadonlySet<StandardWaitToken>;
  readonly customWaits: ReadonlySet<string>;
}

const emptyReasons = (): AttentionReasons => ({
  settledRun: false,
  subagent: false,
  standardWaits: new Set(),
  customWaits: new Set(),
});

const needsAttention = (reasons: AttentionReasons): boolean =>
  reasons.settledRun ||
  reasons.subagent ||
  reasons.standardWaits.size > 0 ||
  reasons.customWaits.size > 0;

interface AttentionHooksGeneration {
  readonly id: number;
  readonly token: GenerationToken;
  readonly listenerScope: Scope.CloseableScope;
  readonly workScope: Scope.CloseableScope;
  readonly reasons: Ref.Ref<AttentionReasons>;
  readonly reasonMutex: Effect.Semaphore;
  readonly marker: TmuxMarker;
}

class AttentionHooksSubscriptionError extends Data.TaggedError(
  "AttentionHooksSubscriptionError",
)<{
  readonly operation: "subscribe" | "unsubscribe";
  readonly message: string;
}> {}

const subscriptionError = (
  operation: AttentionHooksSubscriptionError["operation"],
  cause: unknown,
): AttentionHooksSubscriptionError =>
  new AttentionHooksSubscriptionError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const AttentionHooksLiveLayer = Layer.mergeAll(
  EnvironmentService.Live,
  HomeDirectoryService.Live,
  FileSystemService.Live,
  ProcessService.Live,
);

export const registerAttentionHooks = async (
  port: AttentionHooksRegistrationPort,
  runner: AttentionHooksRunner,
): Promise<void> => {
  const pendingCompletion = await runner.runPromise(
    Ref.make<Option.Option<boolean>>(Option.none()),
  );
  const rootScope = await runner.runPromise(Scope.make());
  const currentGeneration = await runner.runPromise(
    Ref.make<Option.Option<AttentionHooksGeneration>>(Option.none()),
  );
  const lifecycleMutex = await runner.runPromise(Effect.makeSemaphore(1));
  let nextGenerationId = 0;
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  const makeGeneration = (
    id: number,
    session: AttentionHooksSession,
  ): Effect.Effect<
    AttentionHooksGeneration,
    never,
    AttentionHooksDependencies
  > =>
    Effect.gen(function* () {
      const listenerScope = yield* Scope.fork(
        rootScope,
        ExecutionStrategy.sequential,
      );
      const workScope = yield* Scope.fork(
        rootScope,
        ExecutionStrategy.sequential,
      );
      const reasons = yield* Ref.make(emptyReasons());
      const reasonMutex = yield* Effect.makeSemaphore(1);
      const marker = yield* makeTmuxMarker(session.mode);
      return {
        id,
        token: { active: false },
        listenerScope,
        workScope,
        reasons,
        reasonMutex,
        marker,
      } satisfies AttentionHooksGeneration;
    });

  type GenerationWork = (
    generation: AttentionHooksGeneration,
  ) => Effect.Effect<void, never, AttentionHooksDependencies>;

  const launch = (
    work: GenerationWork,
    expectedGeneration?: number,
  ): Promise<void> => {
    if (closed) return Promise.resolve();

    return runner.runPromise(
      Ref.get(currentGeneration).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (generation) => {
              if (
                !generation.token.active ||
                (expectedGeneration !== undefined &&
                  generation.id !== expectedGeneration)
              ) {
                return Effect.void;
              }
              return Effect.forkIn(
                work(generation).pipe(Effect.catchAllCause(() => Effect.void)),
                generation.workScope,
              ).pipe(Effect.flatMap(Fiber.await), Effect.asVoid);
            },
          }),
        ),
        Effect.catchAllCause(() => Effect.void),
      ),
    );
  };

  const updateReasons = (
    generation: AttentionHooksGeneration,
    update: (current: AttentionReasons) => AttentionReasons,
  ): Effect.Effect<void> =>
    generation.reasonMutex.withPermits(1)(
      Ref.updateAndGet(generation.reasons, update).pipe(
        Effect.flatMap((next) =>
          generation.marker.setWaiting(needsAttention(next)),
        ),
      ),
    );

  const clearPassive = (generation: AttentionHooksGeneration) =>
    updateReasons(generation, (current) => ({
      ...current,
      settledRun: false,
      subagent: false,
    }));

  const beginStandardWait = (
    generation: AttentionHooksGeneration,
    token: StandardWaitToken,
  ) =>
    updateReasons(generation, (current) => ({
      ...current,
      settledRun: false,
      subagent: false,
      standardWaits: new Set([...current.standardWaits, token]),
    }));

  const endStandardWait = (
    generation: AttentionHooksGeneration,
    token: StandardWaitToken,
  ) =>
    updateReasons(generation, (current) => {
      const standardWaits = new Set(current.standardWaits);
      standardWaits.delete(token);
      return { ...current, standardWaits };
    });

  const beginCustomWait = (generation: AttentionHooksGeneration, id: string) =>
    updateReasons(generation, (current) => {
      if (current.customWaits.has(id)) return current;
      return {
        ...current,
        settledRun: false,
        subagent: false,
        customWaits: new Set([...current.customWaits, id]),
      };
    });

  const endCustomWait = (generation: AttentionHooksGeneration, id: string) =>
    updateReasons(generation, (current) => {
      const customWaits = new Set(current.customWaits);
      customWaits.delete(id);
      return { ...current, customWaits };
    });

  const installSubscription = (
    scope: Scope.CloseableScope,
    subscribe: EventSubscription,
    handler: ControlEventHandler,
  ): Effect.Effect<void, AttentionHooksSubscriptionError> =>
    Scope.extend(
      Effect.acquireRelease(
        Effect.try({
          try: () => subscribe(handler),
          catch: (cause) => subscriptionError("subscribe", cause),
        }),
        (unsubscribe) =>
          Effect.try({
            try: unsubscribe,
            catch: (cause) => subscriptionError("unsubscribe", cause),
          }).pipe(Effect.ignore),
      ).pipe(Effect.asVoid),
      scope,
    );

  const signalSubagentAttention = (generation: AttentionHooksGeneration) =>
    Effect.all(
      [
        updateReasons(generation, (current) => ({
          ...current,
          subagent: true,
        })),
        playAttentionSound,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid);

  const installControlSubscription = (
    generation: AttentionHooksGeneration,
  ): Effect.Effect<void, AttentionHooksSubscriptionError> =>
    installSubscription(
      generation.listenerScope,
      (handler) => port.subscribeControlEvent(handler),
      (payload) => {
        if (closed || !generation.token.active) return Promise.resolve();
        return isNeedsAttention(payload)
          ? launch(signalSubagentAttention, generation.id)
          : Promise.resolve();
      },
    );

  const installCustomWaitSubscription = (
    generation: AttentionHooksGeneration,
  ): Effect.Effect<void, AttentionHooksSubscriptionError> =>
    installSubscription(
      generation.listenerScope,
      (handler) => port.subscribeUserInputWait(handler),
      (payload) => {
        if (closed || !generation.token.active) return Promise.resolve();
        if (!isUserInputWaitEvent(payload)) return Promise.resolve();
        return payload.state === "start"
          ? launch(
              (current) => beginCustomWait(current, payload.id),
              generation.id,
            )
          : launch(
              (current) => endCustomWait(current, payload.id),
              generation.id,
            );
      },
    );

  const installStandardUiObserver = (
    generation: AttentionHooksGeneration,
    ui: ObservedExtensionUI,
  ): Effect.Effect<void, AttentionHooksSubscriptionError> =>
    generation.marker.interactiveRoot
      ? Scope.extend(
          Effect.acquireRelease(
            Effect.try({
              try: () =>
                installUiWaitObserver(ui, {
                  beginStandardWait: (token) =>
                    launch(
                      (current) => beginStandardWait(current, token),
                      generation.id,
                    ),
                  endStandardWait: (token) =>
                    launch(
                      (current) => endStandardWait(current, token),
                      generation.id,
                    ),
                }),
              catch: (cause) => subscriptionError("subscribe", cause),
            }),
            (dispose) =>
              Effect.try({
                try: dispose,
                catch: (cause) => subscriptionError("unsubscribe", cause),
              }).pipe(Effect.ignore),
          ).pipe(Effect.asVoid),
          generation.listenerScope,
        )
      : Effect.void;

  const bestEffort = <R>(
    effect: Effect.Effect<void, never, R>,
  ): Effect.Effect<void, never, R> =>
    effect.pipe(Effect.catchAllCause(() => Effect.void));

  const resetGeneration = (generation: AttentionHooksGeneration) =>
    generation.reasonMutex.withPermits(1)(
      Ref.set(generation.reasons, emptyReasons()).pipe(
        Effect.zipRight(generation.marker.setWaiting(false)),
      ),
    );

  const closeGeneration = (generation: AttentionHooksGeneration) =>
    Effect.gen(function* () {
      generation.token.active = false;
      yield* bestEffort(Scope.close(generation.listenerScope, Exit.void));
      yield* bestEffort(Scope.close(generation.workScope, Exit.void));
      yield* Ref.set(pendingCompletion, Option.none());
      yield* bestEffort(resetGeneration(generation));
    });

  const replaceGeneration = (session: AttentionHooksSession) =>
    lifecycleMutex.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* Ref.get(currentGeneration);
        if (Option.isSome(previous)) yield* closeGeneration(previous.value);

        const next = yield* makeGeneration(nextGenerationId, session);
        nextGenerationId += 1;
        yield* Ref.set(currentGeneration, Option.some(next));
        yield* next.marker.setWaiting(false);
        yield* installControlSubscription(next);
        yield* installCustomWaitSubscription(next);
        yield* installStandardUiObserver(next, session.ui);
        next.token.active = true;
      }),
    );

  const shutdown = lifecycleMutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.getAndSet(currentGeneration, Option.none());
      if (Option.isSome(current)) yield* closeGeneration(current.value);
    }).pipe(Effect.ensuring(bestEffort(Scope.close(rootScope, Exit.void)))),
  );

  port.onSessionStart((session) =>
    closed ? Promise.resolve() : runner.runPromise(replaceGeneration(session)),
  );

  port.onInput(() =>
    launch((generation) =>
      Ref.set(pendingCompletion, Option.none()).pipe(
        Effect.zipRight(clearPassive(generation)),
      ),
    ),
  );

  port.onAgentStart(() =>
    launch((generation) =>
      Ref.set(pendingCompletion, Option.none()).pipe(
        Effect.zipRight(clearPassive(generation)),
      ),
    ),
  );

  port.onAgentEnd((event) =>
    launch(() =>
      Ref.set(
        pendingCompletion,
        Option.some(completionShouldNotify(event.messages)),
      ),
    ),
  );

  port.onAgentSettled(() =>
    launch((generation) =>
      Ref.getAndSet(pendingCompletion, Option.none()).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (shouldNotify) =>
              shouldNotify
                ? Effect.all(
                    [
                      updateReasons(generation, (current) => ({
                        ...current,
                        settledRun: true,
                      })),
                      playAttentionSound,
                    ],
                    { concurrency: "unbounded" },
                  ).pipe(Effect.asVoid)
                : Effect.void,
          }),
        ),
      ),
    ),
  );

  port.onSessionShutdown(() => {
    shutdownPromise ??= (async () => {
      closed = true;
      try {
        await runner.runPromise(shutdown);
      } finally {
        await runner.dispose();
      }
    })();
    return shutdownPromise;
  });
};

export default async function attentionHooksExtension(pi: ExtensionAPI) {
  const runner = makeEffectRunner(AttentionHooksLiveLayer);
  await registerAttentionHooks(
    {
      onSessionStart: (handler) =>
        pi.on("session_start", (_event, ctx) =>
          handler({ mode: ctx.mode, ui: ctx.ui }),
        ),
      onInput: (handler) => pi.on("input", () => handler()),
      onAgentStart: (handler) => pi.on("agent_start", () => handler()),
      onAgentEnd: (handler) => pi.on("agent_end", handler),
      onAgentSettled: (handler) => pi.on("agent_settled", () => handler()),
      onSessionShutdown: (handler) =>
        pi.on("session_shutdown", () => handler()),
      subscribeControlEvent: (handler) =>
        pi.events.on("subagent:control-event", handler),
      subscribeUserInputWait: (handler) =>
        pi.events.on("attention-hooks:user-input-wait", handler),
    },
    runner,
  );
}
