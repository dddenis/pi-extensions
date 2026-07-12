import type {
  AgentEndEvent,
  ExtensionAPI,
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

type AttentionHooksDependencies =
  | EnvironmentService
  | FileSystemService
  | HomeDirectoryService
  | ProcessService;

type AsyncHandler = () => Promise<void>;
type AgentEndHandler = (event: AgentEndEvent) => Promise<void>;
type ControlEventHandler = (payload: unknown) => Promise<void>;

export interface AttentionHooksRegistrationPort {
  readonly onSessionStart: (handler: AsyncHandler) => void;
  readonly onAgentStart: (handler: AsyncHandler) => void;
  readonly onAgentEnd: (handler: AgentEndHandler) => void;
  readonly onAgentSettled: (handler: AsyncHandler) => void;
  readonly onSessionShutdown: (handler: AsyncHandler) => void;
  readonly subscribeControlEvent: (handler: ControlEventHandler) => () => void;
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

interface AttentionHooksGeneration {
  readonly id: number;
  readonly token: GenerationToken;
  readonly listenerScope: Scope.CloseableScope;
  readonly workScope: Scope.CloseableScope;
}

interface AttentionHooksLifecycleState {
  readonly phase: "open" | "transitioning" | "closed";
  readonly generation: AttentionHooksGeneration;
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

  const makeGeneration = (
    id: number,
  ): Effect.Effect<AttentionHooksGeneration> =>
    Effect.gen(function* () {
      const listenerScope = yield* Scope.fork(
        rootScope,
        ExecutionStrategy.sequential,
      );
      const workScope = yield* Scope.fork(
        rootScope,
        ExecutionStrategy.sequential,
      );
      return {
        id,
        token: { active: false },
        listenerScope,
        workScope,
      };
    });

  const initialGeneration = await runner.runPromise(makeGeneration(0));
  initialGeneration.token.active = true;
  const lifecycleState = await runner.runPromise(
    Ref.make<AttentionHooksLifecycleState>({
      phase: "open",
      generation: initialGeneration,
    }),
  );
  const lifecycleMutex = await runner.runPromise(Effect.makeSemaphore(1));
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  const launch = (
    effect: Effect.Effect<void, never, AttentionHooksDependencies>,
    expectedGeneration?: number,
  ): Promise<void> => {
    if (closed) return Promise.resolve();

    return runner.runPromise(
      Ref.get(lifecycleState).pipe(
        Effect.flatMap((state) => {
          if (
            state.phase !== "open" ||
            !state.generation.token.active ||
            (expectedGeneration !== undefined &&
              state.generation.id !== expectedGeneration)
          ) {
            return Effect.void;
          }

          return Effect.forkIn(
            effect.pipe(Effect.catchAllCause(() => Effect.void)),
            state.generation.workScope,
          ).pipe(Effect.flatMap(Fiber.await), Effect.asVoid);
        }),
        Effect.catchAllCause(() => Effect.void),
      ),
    );
  };

  const closeGeneration = (
    generation: AttentionHooksGeneration,
  ): Effect.Effect<void> =>
    Scope.close(generation.listenerScope, Exit.void).pipe(
      Effect.zipRight(Ref.set(pendingCompletion, Option.none())),
      Effect.zipRight(Scope.close(generation.workScope, Exit.void)),
    );

  const installControlSubscription = (
    generation: AttentionHooksGeneration,
  ): Effect.Effect<void, AttentionHooksSubscriptionError> =>
    Scope.extend(
      Effect.acquireRelease(
        Effect.try({
          try: () =>
            port.subscribeControlEvent((payload) => {
              if (closed || !generation.token.active) {
                return Promise.resolve();
              }
              return isNeedsAttention(payload)
                ? launch(playAttentionSound, generation.id)
                : Promise.resolve();
            }),
          catch: (cause) => subscriptionError("subscribe", cause),
        }),
        (unsubscribe) =>
          Effect.try({
            try: unsubscribe,
            catch: (cause) => subscriptionError("unsubscribe", cause),
          }).pipe(Effect.ignore),
      ).pipe(Effect.asVoid),
      generation.listenerScope,
    );

  const replaceGeneration = lifecycleMutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(lifecycleState);
      if (current.phase === "closed") return;

      current.generation.token.active = false;
      yield* Ref.set(lifecycleState, {
        phase: "transitioning",
        generation: current.generation,
      } satisfies AttentionHooksLifecycleState);
      yield* closeGeneration(current.generation);

      const next = yield* makeGeneration(current.generation.id + 1);
      yield* Ref.set(lifecycleState, {
        phase: "open",
        generation: next,
      } satisfies AttentionHooksLifecycleState);
      yield* installControlSubscription(next);
      next.token.active = true;
    }),
  );

  const shutdown = lifecycleMutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(lifecycleState);
      if (current.phase === "closed") return;

      current.generation.token.active = false;
      yield* Ref.set(lifecycleState, {
        phase: "closed",
        generation: current.generation,
      } satisfies AttentionHooksLifecycleState);
      yield* closeGeneration(current.generation);
    }).pipe(Effect.ensuring(Scope.close(rootScope, Exit.void))),
  );

  port.onSessionStart(() =>
    closed ? Promise.resolve() : runner.runPromise(replaceGeneration),
  );

  port.onAgentStart(() => launch(Ref.set(pendingCompletion, Option.none())));

  port.onAgentEnd((event) =>
    launch(
      Ref.set(
        pendingCompletion,
        Option.some(completionShouldNotify(event.messages)),
      ),
    ),
  );

  port.onAgentSettled(() =>
    launch(
      Ref.getAndSet(pendingCompletion, Option.none()).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (shouldNotify) =>
              shouldNotify ? playAttentionSound : Effect.void,
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
      onSessionStart: (handler) => pi.on("session_start", () => handler()),
      onAgentStart: (handler) => pi.on("agent_start", () => handler()),
      onAgentEnd: (handler) => pi.on("agent_end", handler),
      onAgentSettled: (handler) => pi.on("agent_settled", () => handler()),
      onSessionShutdown: (handler) =>
        pi.on("session_shutdown", () => handler()),
      subscribeControlEvent: (handler) =>
        pi.events.on("subagent:control-event", handler),
    },
    runner,
  );
}
