import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Data, Effect, Layer } from "effect";
import { makeEffectRunner } from "../lib/effect-runtime";
import { FullBox } from "../lib/full-box";
import { FileSystemService } from "../services/file-system";
import { HistorySearchEngineLive } from "./history-search-engine";
import {
  makeHistorySearchService,
  type HistorySearchService,
} from "./history-search-service";
import {
  HISTORY_PICKER_LAYOUT_POLICY,
  historyPickerBorderEnabled,
} from "./layout";
import {
  HistoryPickerComponent,
  type HistoryPickerSearchPort,
  type HistoryPickerViewport,
} from "./picker";
import { SessionListingService } from "./services";
import { makeHistoryIndexer, type HistoryIndexer } from "./session-indexer";
import { indexCurrentSessionEntries } from "./session-items";

export type HistoryPickerNativeTui = Pick<TUI, "requestRender"> & {
  readonly terminal: Pick<TUI["terminal"], "rows">;
};

export interface HistoryPickerOverlayOptions {
  readonly overlay: true;
  readonly overlayOptions: {
    readonly width: 100;
    readonly minWidth: 50;
    readonly maxHeight: typeof HISTORY_PICKER_LAYOUT_POLICY.maximumHeight;
    readonly margin: typeof HISTORY_PICKER_LAYOUT_POLICY.marginRows;
  };
}

export type HistoryPickerOverlayFactory = (
  tui: HistoryPickerNativeTui,
  theme: Pick<Theme, "fg" | "bold">,
  keybindings: Pick<KeybindingsManager, "matches">,
  done: (result: string | undefined) => void,
) => FullBox<HistoryPickerComponent>;

export interface HistoryPickerContext {
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly entries: ReadonlyArray<SessionEntry>;
  readonly getEditorText: () => string;
  readonly setEditorText: (text: string) => void;
  readonly notify: (
    message: string,
    level: "info" | "warning" | "error",
  ) => void;
  readonly custom: (
    factory: HistoryPickerOverlayFactory,
    options: HistoryPickerOverlayOptions,
  ) => Promise<string | undefined>;
}

export interface HistoryPickerRegistrationPort {
  readonly registerShortcut: (
    key: "ctrl+r",
    description: "Search previous user messages",
    handler: (context: HistoryPickerContext) => Promise<void>,
  ) => void;
  readonly onSessionShutdown: (handler: () => Promise<void>) => void;
}

export interface HistoryPickerRuntime {
  readonly makeIndexer: () => Promise<HistoryIndexer>;
  readonly makeSearchService: () => Promise<HistorySearchService>;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => void;
  readonly dispose: () => Promise<void>;
}

const toHistoryPickerViewport = (
  tui: HistoryPickerNativeTui,
): HistoryPickerViewport => ({
  requestRender: () => tui.requestRender(),
  terminalRows: () => tui.terminal.rows,
});

const overlayOptions: HistoryPickerOverlayOptions = {
  overlay: true,
  overlayOptions: {
    width: 100,
    minWidth: 50,
    maxHeight: HISTORY_PICKER_LAYOUT_POLICY.maximumHeight,
    margin: HISTORY_PICKER_LAYOUT_POLICY.marginRows,
  },
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

class HistoryPickerOverlayError extends Data.TaggedError(
  "HistoryPickerOverlayError",
)<{
  readonly message: string;
}> {}

interface TrackedHistorySearchService {
  readonly service: HistorySearchService;
  readonly shutdown: Effect.Effect<void>;
}

export const registerHistoryPicker = (
  port: HistoryPickerRegistrationPort,
  runtime: HistoryPickerRuntime,
): void => {
  let indexerPromise: Promise<HistoryIndexer> | undefined;
  const activeSearchServices = new Map<
    HistorySearchService,
    Effect.Effect<void>
  >();
  const searchServiceLifecycles = new Set<Promise<void>>();
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  const getIndexer = (): Promise<HistoryIndexer> => {
    indexerPromise ??= runtime.makeIndexer();
    return indexerPromise;
  };

  const makeTrackedSearchService = async (): Promise<
    TrackedHistorySearchService | undefined
  > => {
    let resolveLifecycle: (() => void) | undefined;
    const lifecycle = new Promise<void>((resolve) => {
      resolveLifecycle = resolve;
    });
    searchServiceLifecycles.add(lifecycle);
    const completeLifecycle = (): void => {
      const resolve = resolveLifecycle;
      if (resolve === undefined) return;
      resolveLifecycle = undefined;
      searchServiceLifecycles.delete(lifecycle);
      resolve();
    };

    try {
      const service = await runtime.makeSearchService();
      const shutdown = service.shutdown.pipe(
        Effect.zipRight(
          Effect.sync(() => {
            activeSearchServices.delete(service);
            completeLifecycle();
          }),
        ),
      );
      activeSearchServices.set(service, shutdown);
      if (closed) {
        await runtime.runPromise(shutdown);
        return undefined;
      }
      return { service, shutdown };
    } catch (cause) {
      completeLifecycle();
      throw cause;
    }
  };

  const openHistoryPicker = async (
    context: HistoryPickerContext,
  ): Promise<void> => {
    if (context.mode !== "tui") {
      if (context.hasUI) {
        context.notify(
          "History picker requires interactive TUI mode.",
          "warning",
        );
      }
      return;
    }
    if (closed) {
      return;
    }

    try {
      const indexer = await getIndexer();
      if (closed) {
        return;
      }
      const currentItems = indexCurrentSessionEntries(
        context.entries,
        context.sessionFile,
        context.cwd,
      );
      let latestSnapshot = await runtime.runPromise(indexer.snapshot);
      if (closed) {
        return;
      }
      const trackedSearchService = await makeTrackedSearchService();
      if (trackedSearchService === undefined) {
        return;
      }
      const { service: searchService, shutdown: searchServiceShutdown } =
        trackedSearchService;
      let latestSearchSnapshot = await runtime.runPromise(
        searchService.snapshot,
      );
      if (closed) {
        await runtime.runPromise(searchServiceShutdown);
        return;
      }
      let component: HistoryPickerComponent | undefined;
      const searchPort: HistoryPickerSearchPort = {
        replaceItems: (items) =>
          runtime.runFork(searchService.replaceItems(items)),
        search: (request) => runtime.runFork(searchService.search(request)),
      };

      const selected = await runtime.runPromise(
        Effect.acquireUseRelease(
          indexer.subscribe((snapshot) => {
            latestSnapshot = snapshot;
            component?.setSavedSnapshot(snapshot);
          }),
          () =>
            Effect.acquireUseRelease(
              Effect.succeed(searchService),
              () =>
                Effect.acquireUseRelease(
                  searchService.subscribe((snapshot) => {
                    latestSearchSnapshot = snapshot;
                    component?.setSearchSnapshot(snapshot);
                  }),
                  () => {
                    void runtime
                      .runPromise(indexer.refresh)
                      .catch(() => undefined);
                    return Effect.tryPromise({
                      try: () =>
                        context.custom((tui, theme, keybindings, done) => {
                          const picker = new HistoryPickerComponent({
                            viewport: toHistoryPickerViewport(tui),
                            theme,
                            keybindings,
                            searchPort,
                            currentItems,
                            snapshot: latestSnapshot,
                            initialSearch: latestSearchSnapshot,
                            initialQuery: context.getEditorText(),
                            currentCwd: context.cwd,
                            onSelect: done,
                            onCancel: () => done(undefined),
                          });
                          component = picker;
                          return new FullBox(picker, {
                            color: (text: string) => theme.fg("accent", text),
                            enabled: (width) =>
                              historyPickerBorderEnabled(
                                tui.terminal.rows,
                                width,
                              ),
                            focusTarget: picker,
                            onFrameActive: (frameActive) =>
                              picker.setFrameActiveForRender(frameActive),
                          });
                        }, overlayOptions),
                      catch: (cause) =>
                        new HistoryPickerOverlayError({
                          message: errorMessage(cause),
                        }),
                    });
                  },
                  (removeSearchListener) => removeSearchListener,
                ),
              () => searchServiceShutdown,
            ),
          (removeSavedListener) => removeSavedListener,
        ),
      );

      if (!closed && selected !== undefined) {
        context.setEditorText(selected);
      }
    } catch (cause) {
      if (!closed) {
        context.notify(
          `History picker failed: ${errorMessage(cause)}`,
          "error",
        );
      }
    }
  };

  port.registerShortcut(
    "ctrl+r",
    "Search previous user messages",
    openHistoryPicker,
  );

  port.onSessionShutdown(() => {
    shutdownPromise ??= (async () => {
      closed = true;
      if (indexerPromise !== undefined) {
        try {
          const indexer = await indexerPromise;
          await runtime.runPromise(indexer.shutdown);
        } catch {
          // Runtime disposal remains required even if indexer creation failed.
        }
      }
      const searchServiceShutdowns = [...activeSearchServices.values()];
      const searchLifecycles = [...searchServiceLifecycles];
      await Promise.all([
        ...searchServiceShutdowns.map((effect) => runtime.runPromise(effect)),
        ...searchLifecycles,
      ]);
      activeSearchServices.clear();
      await runtime.dispose();
    })();
    return shutdownPromise;
  });
};

export const HistoryPickerLiveLayer = Layer.mergeAll(
  FileSystemService.Live,
  SessionListingService.Live,
  HistorySearchEngineLive,
);

const toHistoryPickerContext = (
  context: ExtensionContext,
): HistoryPickerContext => ({
  mode: context.mode,
  hasUI: context.hasUI,
  cwd: context.cwd,
  sessionFile: context.sessionManager.getSessionFile() ?? "",
  entries: context.sessionManager.getEntries(),
  getEditorText: () => context.ui.getEditorText(),
  setEditorText: (text) => context.ui.setEditorText(text),
  notify: (message, level) => context.ui.notify(message, level),
  custom: (factory, options) =>
    context.ui.custom<string | undefined>(
      (tui, theme, keybindings, done) => factory(tui, theme, keybindings, done),
      options,
    ),
});

export default function historyPickerExtension(pi: ExtensionAPI): void {
  const runner = makeEffectRunner(HistoryPickerLiveLayer);
  const runtime: HistoryPickerRuntime = {
    makeIndexer: () => runner.runPromise(makeHistoryIndexer),
    makeSearchService: () => runner.runPromise(makeHistorySearchService),
    runPromise: (effect) => runner.runPromise(effect),
    runFork: (effect) => {
      runner.runFork(effect);
    },
    dispose: runner.dispose,
  };

  registerHistoryPicker(
    {
      registerShortcut: (key, description, handler) =>
        pi.registerShortcut(key, {
          description,
          handler: (context) => handler(toHistoryPickerContext(context)),
        }),
      onSessionShutdown: (handler) =>
        pi.on("session_shutdown", () => handler()),
    },
    runtime,
  );
}
