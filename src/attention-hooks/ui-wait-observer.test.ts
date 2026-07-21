import { describe, expect, it, vi } from "vitest";
import {
  installUiWaitObserver,
  isUserInputWaitEvent,
  type ObservedExtensionUI,
  type StandardWaitToken,
} from "./ui-wait-observer";

const makeUi = (): ObservedExtensionUI => ({
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  editor: async () => undefined,
});

const installRecorder = (ui: ObservedExtensionUI, events: Array<string>) =>
  installUiWaitObserver(ui, {
    beginStandardWait: async (token) => {
      events.push(`begin:${token}`);
    },
    endStandardWait: async (token) => {
      events.push(`end:${token}`);
    },
  });

describe("installUiWaitObserver", () => {
  it("marks before every original method and releases after its result", async () => {
    const events: Array<string> = [];
    const ui: ObservedExtensionUI = {
      select: async () => {
        events.push("select");
        return "A";
      },
      confirm: async () => {
        events.push("confirm");
        return true;
      },
      input: async () => {
        events.push("input");
        return "value";
      },
      editor: async () => {
        events.push("editor");
        return "text";
      },
    };
    installRecorder(ui, events);

    await expect(ui.select("title", ["A"])).resolves.toBe("A");
    await expect(ui.confirm("title", "message")).resolves.toBe(true);
    await expect(ui.input("title")).resolves.toBe("value");
    await expect(ui.editor("title")).resolves.toBe("text");

    expect(events).toEqual([
      "begin:0",
      "select",
      "end:0",
      "begin:1",
      "confirm",
      "end:1",
      "begin:2",
      "input",
      "end:2",
      "begin:3",
      "editor",
      "end:3",
    ]);
  });

  it("preserves cancellation values and releases after rejection", async () => {
    const failure = new Error("editor failed");
    const events: Array<string> = [];
    const ui = makeUi();
    ui.editor = async () => {
      events.push("editor");
      throw failure;
    };
    installRecorder(ui, events);

    await expect(ui.select("title", [])).resolves.toBeUndefined();
    await expect(ui.confirm("title", "message")).resolves.toBe(false);
    await expect(ui.input("title")).resolves.toBeUndefined();
    await expect(ui.editor("title")).rejects.toBe(failure);
    expect(events.slice(-3)).toEqual(["begin:3", "editor", "end:3"]);
  });

  it("does not alter a dialog result when observer callbacks fail", async () => {
    const ui = makeUi();
    ui.select = async () => "A";
    installUiWaitObserver(ui, {
      beginStandardWait: async () => {
        throw new Error("begin failed");
      },
      endStandardWait: async () => {
        throw new Error("end failed");
      },
    });

    await expect(ui.select("title", ["A"])).resolves.toBe("A");
  });

  it("runs a dialog when the begin callback throws synchronously", async () => {
    const events: Array<string> = [];
    const ui = makeUi();
    ui.select = async () => {
      events.push("select");
      return "A";
    };
    installUiWaitObserver(ui, {
      beginStandardWait: () => {
        throw new Error("begin failed");
      },
      endStandardWait: async () => undefined,
    });

    await expect(ui.select("title", ["A"])).resolves.toBe("A");
    expect(events).toEqual(["select"]);
  });

  it("preserves a dialog result when the end callback throws synchronously", async () => {
    const ui = makeUi();
    ui.select = async () => "A";
    installUiWaitObserver(ui, {
      beginStandardWait: async () => undefined,
      endStandardWait: () => {
        throw new Error("end failed");
      },
    });

    await expect(ui.select("title", ["A"])).resolves.toBe("A");
  });

  it("preserves a dialog error when the end callback throws synchronously", async () => {
    const failure = new Error("editor failed");
    const ui = makeUi();
    ui.editor = async () => {
      throw failure;
    };
    installUiWaitObserver(ui, {
      beginStandardWait: async () => undefined,
      endStandardWait: () => {
        throw new Error("end failed");
      },
    });

    await expect(ui.editor("title")).rejects.toBe(failure);
  });

  it("assigns distinct tokens to overlapping dialogs", async () => {
    const begins: Array<StandardWaitToken> = [];
    const ends: Array<StandardWaitToken> = [];
    const unresolved = (_value: string | undefined): void => undefined;
    let finishSelect = unresolved;
    let finishInput = unresolved;
    const ui = makeUi();
    ui.select = () =>
      new Promise((resolve) => {
        finishSelect = resolve;
      });
    ui.input = () =>
      new Promise((resolve) => {
        finishInput = resolve;
      });
    installUiWaitObserver(ui, {
      beginStandardWait: async (token) => {
        begins.push(token);
      },
      endStandardWait: async (token) => {
        ends.push(token);
      },
    });

    const select = ui.select("title", ["A"]);
    const input = ui.input("title");
    await vi.waitFor(
      () => {
        expect(finishSelect).not.toBe(unresolved);
        expect(finishInput).not.toBe(unresolved);
      },
      { timeout: 1_000 },
    );
    expect(begins).toEqual([0, 1]);

    finishSelect("A");
    await select;
    expect(ends).toEqual([0]);
    finishInput("value");
    await input;
    expect(ends).toEqual([0, 1]);
  });

  it("restores owned methods and makes captured wrappers inert", async () => {
    const events: Array<string> = [];
    const ui = makeUi();
    const original = ui.select;
    const dispose = installRecorder(ui, events);
    const capturedWrapper = ui.select;

    dispose();
    dispose();
    expect(ui.select).toBe(original);
    await capturedWrapper("title", ["A"]);
    expect(events).toEqual([]);
  });

  it("leaves a composing wrapper in place without late callbacks", async () => {
    const events: Array<string> = [];
    const ui = makeUi();
    const dispose = installRecorder(ui, events);
    const owned = ui.select;
    const composed: ObservedExtensionUI["select"] = (title, options, opts) =>
      owned(title, options, opts);
    ui.select = composed;

    dispose();
    expect(ui.select).toBe(composed);
    await ui.select("title", ["A"]);
    expect(events).toEqual([]);
  });
});

describe("isUserInputWaitEvent", () => {
  it("accepts only the two non-empty identifier payloads", () => {
    expect(isUserInputWaitEvent({ state: "start", id: "question:42" })).toBe(
      true,
    );
    expect(isUserInputWaitEvent({ state: "end", id: "question:42" })).toBe(
      true,
    );
    expect(isUserInputWaitEvent({ state: "start", id: "" })).toBe(false);
    expect(isUserInputWaitEvent({ state: "other", id: "question:42" })).toBe(
      false,
    );
    expect(isUserInputWaitEvent({ state: "start", id: 42 })).toBe(false);
    expect(isUserInputWaitEvent(null)).toBe(false);
  });
});
