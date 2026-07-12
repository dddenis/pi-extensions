import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Keybinding,
  type KeybindingsManager,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { HistorySearchRequest } from "./history-search-engine";
import type { HistorySearchService } from "./history-search-service";
import {
  registerHistoryPicker,
  type HistoryPickerContext,
  type HistoryPickerRegistrationPort,
  type HistoryPickerRuntime,
} from "./index";
import {
  HISTORY_PICKER_LAYOUT_POLICY,
  historyPickerOverlayRows,
} from "./layout";
import type { HistoryIndexer } from "./session-indexer";
import type {
  HistoryItem,
  HistorySearchSnapshot,
  HistorySnapshot,
} from "./types";

const userEntry = (
  id: string,
  text: string,
  timestamp: number,
  parentId: string | null = null,
): SessionEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  message: { role: "user", content: text, timestamp },
});

const historyResult = (index: number): HistoryItem => ({
  text: `result-${index}`,
  timestamp: 100 - index,
  cwd: "/project",
  sessionFile: `/sessions/result-${index}.jsonl`,
  source: "saved",
});

const flush = async () => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
};

const makeTui = (terminal: { rows: number } = { rows: 24 }) => ({
  requestRender: () => undefined,
  terminal,
});

interface FakeIndexerState {
  listeners: Set<(snapshot: HistorySnapshot) => void>;
  refreshes: number;
  shutdowns: number;
  snapshot: HistorySnapshot;
}

const makeIndexer = (
  snapshot: HistorySnapshot = { savedItems: [], loading: false },
  onShutdown: () => void = () => undefined,
  onRemove: () => void = () => undefined,
) => {
  const state: FakeIndexerState = {
    listeners: new Set(),
    refreshes: 0,
    shutdowns: 0,
    snapshot,
  };
  const indexer: HistoryIndexer = {
    snapshot: Effect.sync(() => state.snapshot),
    refresh: Effect.sync(() => {
      state.refreshes += 1;
      return state.snapshot;
    }),
    subscribe: (listener) =>
      Effect.sync(() => {
        state.listeners.add(listener);
        listener(state.snapshot);
        return Effect.sync(() => {
          state.listeners.delete(listener);
          onRemove();
        });
      }),
    shutdown: Effect.sync(() => {
      state.shutdowns += 1;
      state.listeners.clear();
      onShutdown();
    }),
  };
  return { indexer, state };
};

interface FakeSearchState {
  listeners: Set<(snapshot: HistorySearchSnapshot) => void>;
  replacements: ReadonlyArray<HistoryItem>[];
  requests: HistorySearchRequest[];
  shutdownAttempts: number;
  shutdowns: number;
  snapshot: HistorySearchSnapshot;
}

const makeSearchService = (
  snapshot: HistorySearchSnapshot,
  onShutdown: () => Promise<void>,
  onRemove: () => void,
) => {
  const state: FakeSearchState = {
    listeners: new Set(),
    replacements: [],
    requests: [],
    shutdownAttempts: 0,
    shutdowns: 0,
    snapshot,
  };
  let shutdownPromise: Promise<void> | undefined;
  const service: HistorySearchService = {
    snapshot: Effect.sync(() => state.snapshot),
    replaceItems: (items) =>
      Effect.sync(() => {
        state.replacements.push([...items]);
      }),
    search: (request) =>
      Effect.sync(() => {
        state.requests.push({ ...request });
      }),
    subscribe: (listener) =>
      Effect.sync(() => {
        state.listeners.add(listener);
        listener(state.snapshot);
        return Effect.sync(() => {
          state.listeners.delete(listener);
          onRemove();
        });
      }),
    shutdown: Effect.suspend(() => {
      state.shutdownAttempts += 1;
      if (shutdownPromise === undefined) {
        state.shutdowns += 1;
        state.listeners.clear();
        shutdownPromise = onShutdown();
      }
      return Effect.promise(() => shutdownPromise ?? Promise.resolve());
    }),
  };
  return {
    service,
    state,
    publish: (publication: HistorySearchSnapshot) => {
      state.snapshot = publication;
      for (const listener of state.listeners) listener(publication);
    },
  };
};

const makeHarness = (
  options: {
    readonly mode?: HistoryPickerContext["mode"];
    readonly hasUI?: boolean;
    readonly custom?: HistoryPickerContext["custom"];
    readonly entries?: ReadonlyArray<SessionEntry>;
    readonly editorText?: string;
    readonly initialSearch?: HistorySearchSnapshot;
    readonly searchFactory?: () => Promise<void>;
    readonly searchShutdown?: () => Promise<void>;
  } = {},
) => {
  const order: string[] = [];
  const savedItem: HistoryItem = {
    text: " saved prompt ",
    timestamp: 5,
    cwd: "/other",
    sessionFile: "/sessions/saved.jsonl",
    source: "saved",
  };
  const made = makeIndexer(
    {
      savedItems: [savedItem],
      loading: false,
    },
    () => order.push("indexer.shutdown"),
    () => order.push("saved.listener.remove"),
  );
  const searches: Array<ReturnType<typeof makeSearchService>> = [];
  let makeIndexerCalls = 0;
  let makeSearchServiceCalls = 0;
  let disposeCalls = 0;
  const runtime: HistoryPickerRuntime = {
    makeIndexer: async () => {
      makeIndexerCalls += 1;
      return made.indexer;
    },
    makeSearchService: async () => {
      makeSearchServiceCalls += 1;
      const search = makeSearchService(
        options.initialSearch ?? {
          results: [{ item: savedItem }],
          hasMoreResults: false,
          searching: false,
        },
        async () => {
          order.push("search.shutdown");
          await (options.searchShutdown?.() ?? Promise.resolve());
        },
        () => order.push("search.listener.remove"),
      );
      searches.push(search);
      await (options.searchFactory?.() ?? Promise.resolve());
      return search.service;
    },
    runPromise: (effect) => Effect.runPromise(effect),
    runFork: (effect) => {
      Effect.runFork(effect);
    },
    dispose: async () => {
      disposeCalls += 1;
      order.push("runtime.dispose");
    },
  };

  let shortcut:
    | {
        key: string;
        description: string;
        handler: (context: HistoryPickerContext) => Promise<void>;
      }
    | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const port: HistoryPickerRegistrationPort = {
    registerShortcut: (key, description, handler) => {
      shortcut = { key, description, handler };
    },
    onSessionShutdown: (handler) => {
      shutdown = handler;
    },
  };

  const notifications: Array<readonly [string, "info" | "warning" | "error"]> =
    [];
  const editorWrites: string[] = [];
  const context: HistoryPickerContext = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    cwd: "/project",
    sessionFile: "/sessions/current.jsonl",
    entries: options.entries ?? [
      userEntry("root0001", "root prompt", 1),
      userEntry("branch01", "abandoned branch", 2, "root0001"),
    ],
    getEditorText: () => options.editorText ?? "root",
    setEditorText: (text) => editorWrites.push(text),
    notify: (message, level) => notifications.push([message, level]),
    custom:
      options.custom ??
      (async (factory) => {
        let result: string | undefined;
        const component = factory(
          makeTui(),
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {
            matches: (data: string, binding: Keybinding) =>
              data === "CONFIRM" && binding === "tui.select.confirm",
          },
          (selected) => {
            result = selected;
          },
        );
        expect(component.child.query).toBe(options.editorText ?? "root");
        component.handleInput("CONFIRM");
        return result;
      }),
  };

  registerHistoryPicker(port, runtime);
  const required = <A>(value: A | undefined, name: string): A => {
    if (value === undefined) throw new Error(`${name} was not registered`);
    return value;
  };

  return {
    made,
    searches,
    order,
    context,
    notifications,
    editorWrites,
    get makeIndexerCalls() {
      return makeIndexerCalls;
    },
    get makeSearchServiceCalls() {
      return makeSearchServiceCalls;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    invoke: () => required(shortcut, "shortcut").handler(context),
    shutdown: () => required(shutdown, "shutdown")(),
    shortcut: () => required(shortcut, "shortcut"),
  };
};

describe("history picker extension", () => {
  it("registers only the exact shortcut and description", () => {
    const harness = makeHarness();
    expect(harness.shortcut()).toMatchObject({
      key: "ctrl+r",
      description: "Search previous user messages",
    });
  });

  it("warns in RPC and stays silent in JSON/print without listing", async () => {
    const rpc = makeHarness({ mode: "rpc", hasUI: true });
    await rpc.invoke();
    expect(rpc.notifications).toEqual([
      ["History picker requires interactive TUI mode.", "warning"],
    ]);
    expect(rpc.makeIndexerCalls).toBe(0);

    for (const mode of ["json", "print"] as const) {
      const harness = makeHarness({ mode, hasUI: false });
      await harness.invoke();
      expect(harness.notifications).toEqual([]);
      expect(harness.makeIndexerCalls).toBe(0);
    }
  });

  it("prefills from the editor, uses exact overlay options, and inserts exact selected text", async () => {
    let overlayOptions: unknown;
    const harness = makeHarness({
      editorText: "saved",
      custom: async (factory, options) => {
        overlayOptions = options;
        let result: string | undefined;
        const component = factory(
          makeTui(),
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {
            matches: (data: string, binding: Keybinding) =>
              data === "CONFIRM" && binding === "tui.select.confirm",
          },
          (selected) => {
            result = selected;
          },
        );
        expect(component.child.query).toBe("saved");
        component.handleInput("CONFIRM");
        return result;
      },
    });

    await harness.invoke();
    expect(overlayOptions).toEqual({
      overlay: true,
      overlayOptions: {
        width: 100,
        minWidth: 50,
        maxHeight: HISTORY_PICKER_LAYOUT_POLICY.maximumHeight,
        margin: HISTORY_PICKER_LAYOUT_POLICY.marginRows,
      },
    });
    expect(harness.editorWrites).toEqual([" saved prompt "]);
    expect(harness.searches[0]?.state.shutdowns).toBe(1);
  });

  it("adds and removes the full border from live terminal height without replacing the picker", async () => {
    const terminal = { rows: 24 };
    let tallLines: ReadonlyArray<string> = [];
    let shortLines: ReadonlyArray<string> = [];
    let restoredLines: ReadonlyArray<string> = [];
    const harness = makeHarness({
      editorText: "",
      custom: async (factory) => {
        const component = factory(
          makeTui(terminal),
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          { matches: () => false },
          () => undefined,
        );
        const picker = component.child;
        tallLines = component.render(80);
        terminal.rows = 6;
        shortLines = component.render(80);
        terminal.rows = 24;
        restoredLines = component.render(80);
        expect(component.child).toBe(picker);
        return undefined;
      },
    });

    await harness.invoke();
    expect(tallLines[0]).toBe(`┌${"─".repeat(78)}┐`);
    expect(tallLines.at(-1)).toBe(`└${"─".repeat(78)}┘`);
    expect(tallLines.join("\n")).toContain("History");
    expect(shortLines).toHaveLength(2);
    expect(shortLines.some((line) => line.startsWith("Search: "))).toBe(true);
    expect(shortLines.some((line) => line.startsWith("> "))).toBe(true);
    expect(shortLines.join("\n")).not.toContain("History");
    expect(shortLines.join("\n")).not.toContain("Scope:");
    expect(restoredLines[0]).toBe(`┌${"─".repeat(78)}┐`);
    expect(restoredLines.at(-1)).toBe(`└${"─".repeat(78)}┘`);
  });

  it("uses the full row budget at narrow width when the border cannot fit", async () => {
    const terminal = { rows: 23 };
    const results = Array.from({ length: 20 }, (_, index) =>
      historyResult(index),
    );
    let narrowLines: ReadonlyArray<string> = [];
    const harness = makeHarness({
      editorText: "",
      initialSearch: {
        results: results.map((historyItem) => ({ item: historyItem })),
        hasMoreResults: false,
        searching: true,
        warning: "partial history",
      },
      custom: async (factory) => {
        const component = factory(
          makeTui(terminal),
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          { matches: () => false },
          () => undefined,
        );
        narrowLines = component.render(2);
        return undefined;
      },
    });

    await harness.invoke();
    expect(narrowLines).toHaveLength(historyPickerOverlayRows(terminal.rows));
    expect(narrowLines[0]).not.toContain("┌");
    expect(narrowLines.at(-1)).not.toContain("┘");
    expect(narrowLines.every((line) => visibleWidth(line) <= 2)).toBe(true);
    expect(
      narrowLines.filter((line) => line === "> " || line === "  "),
    ).toHaveLength(12);
  });

  it("inserts an exact multiline selection", async () => {
    const raw = "  first line\n\nsecond line\n  ";
    const harness = makeHarness({
      custom: async () => raw,
    });

    await harness.invoke();

    expect(harness.editorWrites).toEqual([raw]);
  });

  it("projects every current-session entry afresh into each overlay service", async () => {
    const entries = [
      userEntry("root0001", "root prompt", 1),
      userEntry("branch01", "abandoned branch", 2, "root0001"),
    ];
    const harness = makeHarness({
      entries,
      editorText: "",
      custom: async (factory) => {
        factory(
          makeTui(),
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          { matches: () => false },
          () => undefined,
        );
        return undefined;
      },
    });

    await harness.invoke();
    entries.push(userEntry("branch02", "later branch", 3, "root0001"));
    await harness.invoke();

    expect(
      harness.searches[0]?.state.replacements[0]?.map((entry) => entry.text),
    ).toEqual(["root prompt", "abandoned branch", " saved prompt "]);
    expect(
      harness.searches[1]?.state.replacements[0]?.map((entry) => entry.text),
    ).toEqual([
      "root prompt",
      "abandoned branch",
      "later branch",
      " saved prompt ",
    ]);
    expect(harness.makeIndexerCalls).toBe(1);
    expect(harness.makeSearchServiceCalls).toBe(2);
    expect(harness.made.state.refreshes).toBe(2);
  });

  it("subscribes before construction and sends the initial request before combined items", async () => {
    const harness = makeHarness({
      editorText: "needle",
      custom: async (factory) => {
        const search = harness.searches[0];
        if (search === undefined)
          throw new Error("search service was not made");
        expect(search.state.listeners.size).toBe(1);

        factory(
          makeTui(),
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          { matches: () => false },
          () => undefined,
        );

        expect(search.state.requests).toEqual([
          { query: "needle", scope: "all", currentCwd: "/project" },
        ]);
        expect(
          search.state.replacements[0]?.map((entry) => entry.text),
        ).toEqual(["root prompt", "abandoned branch", " saved prompt "]);
        return undefined;
      },
    });

    await harness.invoke();
    expect(harness.notifications).toEqual([]);
  });

  it("routes saved replacements and search publications without synchronous result mutation", async () => {
    const prior: HistoryItem = {
      text: "prior result",
      timestamp: 20,
      cwd: "/project",
      sessionFile: "/sessions/prior.jsonl",
      source: "saved",
    };
    const published: HistoryItem = {
      text: "published result",
      timestamp: 21,
      cwd: "/project",
      sessionFile: "/sessions/published.jsonl",
      source: "saved",
    };
    const harness = makeHarness({
      editorText: "",
      initialSearch: {
        results: [{ item: prior }],
        hasMoreResults: false,
        searching: false,
      },
      custom: async (factory) => {
        const component = factory(
          makeTui(),
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          { matches: () => false },
          () => undefined,
        );
        const search = harness.searches[0];
        if (search === undefined)
          throw new Error("search service was not made");

        const saved: HistorySnapshot = {
          savedItems: [{ ...published, text: "new saved item" }],
          loading: false,
        };
        harness.made.state.snapshot = saved;
        for (const listener of harness.made.state.listeners) listener(saved);

        expect(component.child.results[0]?.item.text).toBe("prior result");
        expect(
          search.state.replacements.at(-1)?.map((entry) => entry.text),
        ).toEqual(["root prompt", "abandoned branch", "new saved item"]);

        search.publish({
          results: [{ item: published }],
          hasMoreResults: false,
          searching: false,
        });
        expect(component.child.results[0]?.item.text).toBe("published result");
        return undefined;
      },
    });

    await harness.invoke();
    expect(harness.notifications).toEqual([]);
  });

  it("leaves the editor unchanged on cancellation and releases listener, service, then saved listener", async () => {
    const harness = makeHarness({ custom: async () => undefined });
    await harness.invoke();
    expect(harness.editorWrites).toEqual([]);
    expect(harness.made.state.listeners.size).toBe(0);
    expect(harness.searches[0]?.state.listeners.size).toBe(0);
    expect(harness.searches[0]?.state.shutdowns).toBe(1);
    expect(harness.order).toEqual([
      "search.listener.remove",
      "search.shutdown",
      "saved.listener.remove",
    ]);
  });

  it("releases the listener and reports unexpected overlay failures", async () => {
    const harness = makeHarness({
      custom: async () => {
        expect(harness.made.state.listeners.size).toBe(1);
        throw new Error("overlay exploded");
      },
    });

    await harness.invoke();
    expect(harness.made.state.listeners.size).toBe(0);
    expect(harness.searches[0]?.state.listeners.size).toBe(0);
    expect(harness.searches[0]?.state.shutdowns).toBe(1);
    expect(harness.notifications).toEqual([
      ["History picker failed: overlay exploded", "error"],
    ]);
  });

  it("shuts down the shared indexer before disposing the runtime once", async () => {
    const harness = makeHarness();
    await harness.invoke();
    harness.order.length = 0;
    await harness.shutdown();
    await harness.shutdown();
    await flush();

    expect(harness.order).toEqual(["indexer.shutdown", "runtime.dispose"]);
    expect(harness.made.state.shutdowns).toBe(1);
    expect(harness.disposeCalls).toBe(1);
  });

  it("awaits pending search-service creation and cleanup before runtime disposal", async () => {
    let releaseFactory: (() => void) | undefined;
    let overlayOpens = 0;
    const harness = makeHarness({
      searchFactory: () =>
        new Promise((resolve) => {
          releaseFactory = resolve;
        }),
      custom: async () => {
        overlayOpens += 1;
        return undefined;
      },
    });

    const invocation = harness.invoke();
    await flush();
    expect(harness.makeSearchServiceCalls).toBe(1);
    expect(harness.searches).toHaveLength(1);
    expect(overlayOpens).toBe(0);

    let sessionShutdownComplete = false;
    const shutdown = harness.shutdown().then(() => {
      sessionShutdownComplete = true;
    });
    await flush();

    expect(harness.order).toEqual(["indexer.shutdown"]);
    expect(harness.disposeCalls).toBe(0);
    expect(sessionShutdownComplete).toBe(false);
    expect(harness.searches[0]?.state.shutdowns).toBe(0);

    if (releaseFactory === undefined) {
      throw new Error("search factory did not start");
    }
    releaseFactory();
    await Promise.all([invocation, shutdown]);

    expect(harness.order).toEqual([
      "indexer.shutdown",
      "search.shutdown",
      "runtime.dispose",
    ]);
    expect(harness.searches[0]?.state.shutdownAttempts).toBe(1);
    expect(harness.searches[0]?.state.shutdowns).toBe(1);
    expect(harness.disposeCalls).toBe(1);
    expect(sessionShutdownComplete).toBe(true);
    expect(overlayOpens).toBe(0);
    expect(harness.notifications).toEqual([]);
  });

  it("closes an active overlay listener during shutdown", async () => {
    let finishOverlay: (() => void) | undefined;
    const harness = makeHarness({
      custom: () =>
        new Promise((resolve) => {
          finishOverlay = () => resolve(undefined);
        }),
    });

    const invocation = harness.invoke();
    await flush();
    expect(harness.made.state.listeners.size).toBe(1);

    await harness.shutdown();
    expect(harness.made.state.listeners.size).toBe(0);
    expect(harness.searches[0]?.state.shutdowns).toBe(1);
    expect(harness.order).toEqual([
      "indexer.shutdown",
      "search.shutdown",
      "runtime.dispose",
    ]);

    if (finishOverlay === undefined) {
      throw new Error("overlay did not open");
    }
    finishOverlay();
    await invocation;
    expect(harness.notifications).toEqual([]);
  });

  it("awaits active search interruption before disposing the runtime", async () => {
    let releaseSearch: (() => void) | undefined;
    let finishOverlay: (() => void) | undefined;
    const harness = makeHarness({
      searchShutdown: () =>
        new Promise((resolve) => {
          releaseSearch = resolve;
        }),
      custom: () =>
        new Promise((resolve) => {
          finishOverlay = () => resolve(undefined);
        }),
    });

    const invocation = harness.invoke();
    await flush();
    const shutdown = harness.shutdown();
    await flush();

    expect(harness.order).toEqual(["indexer.shutdown", "search.shutdown"]);
    expect(harness.disposeCalls).toBe(0);
    if (releaseSearch === undefined) {
      throw new Error("search shutdown did not start");
    }
    releaseSearch();
    await shutdown;
    expect(harness.order).toEqual([
      "indexer.shutdown",
      "search.shutdown",
      "runtime.dispose",
    ]);

    if (finishOverlay === undefined) throw new Error("overlay did not open");
    finishOverlay();
    await invocation;
  });

  it("joins service cleanup already started by normal overlay release before runtime disposal", async () => {
    let finishOverlay: (() => void) | undefined;
    let releaseSearch: (() => void) | undefined;
    let searchCleanupComplete = false;
    const harness = makeHarness({
      searchShutdown: () =>
        new Promise((resolve) => {
          releaseSearch = () => {
            searchCleanupComplete = true;
            resolve();
          };
        }),
      custom: () =>
        new Promise((resolve) => {
          finishOverlay = () => resolve(undefined);
        }),
    });

    const invocation = harness.invoke();
    await flush();
    if (finishOverlay === undefined) throw new Error("overlay did not open");
    finishOverlay();
    await flush();

    const search = harness.searches[0];
    if (search === undefined) throw new Error("search service was not made");
    expect(harness.order).toEqual([
      "search.listener.remove",
      "search.shutdown",
    ]);
    expect(search.state.shutdownAttempts).toBe(1);
    expect(search.state.shutdowns).toBe(1);

    let sessionShutdownComplete = false;
    const shutdown = harness.shutdown().then(() => {
      sessionShutdownComplete = true;
    });
    await flush();

    expect(harness.order).toContain("indexer.shutdown");
    expect(search.state.shutdownAttempts).toBe(2);
    expect(search.state.shutdowns).toBe(1);
    expect(searchCleanupComplete).toBe(false);
    expect(sessionShutdownComplete).toBe(false);
    expect(harness.disposeCalls).toBe(0);

    if (releaseSearch === undefined) {
      throw new Error("search shutdown did not start");
    }
    releaseSearch();
    await Promise.all([invocation, shutdown]);

    expect(searchCleanupComplete).toBe(true);
    expect(sessionShutdownComplete).toBe(true);
    expect(search.state.shutdowns).toBe(1);
    expect(search.state.listeners.size).toBe(0);
    expect(harness.made.state.listeners.size).toBe(0);
    expect(
      harness.order.filter((event) => event === "saved.listener.remove"),
    ).toHaveLength(1);
    expect(harness.disposeCalls).toBe(1);

    await harness.shutdown();
    expect(search.state.shutdownAttempts).toBe(2);
    expect(search.state.shutdowns).toBe(1);
    expect(harness.disposeCalls).toBe(1);
  });

  it("does not accept a stale overlay result after shutdown wins the race", async () => {
    let acceptOverlay: (() => void) | undefined;
    const harness = makeHarness({
      custom: () =>
        new Promise((resolve) => {
          acceptOverlay = () => resolve(" stale accepted text ");
        }),
    });

    const invocation = harness.invoke();
    await flush();
    expect(harness.made.state.listeners.size).toBe(1);

    if (acceptOverlay === undefined) {
      throw new Error("overlay did not open");
    }
    acceptOverlay();
    const shutdown = harness.shutdown();

    await shutdown;
    await invocation;
    expect(harness.made.state.listeners.size).toBe(0);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });
});

// Compile-time witnesses that the narrow port uses Pi's public callback shapes.
const _componentWitness: Component | undefined = undefined;
const _tuiWitness:
  | (Pick<TUI, "requestRender"> & {
      readonly terminal: Pick<TUI["terminal"], "rows">;
    })
  | undefined = undefined;
const _themeWitness: Pick<Theme, "fg" | "bold"> | undefined = undefined;
const _keybindingsWitness: Pick<KeybindingsManager, "matches"> | undefined =
  undefined;
void [_componentWitness, _tuiWitness, _themeWitness, _keybindingsWitness];
