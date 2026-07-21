import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

export type StandardWaitToken = number;
export type ObservedExtensionUI = Pick<
  ExtensionUIContext,
  "select" | "confirm" | "input" | "editor"
>;

export interface UIWaitObserverCallbacks {
  readonly beginStandardWait: (token: StandardWaitToken) => Promise<void>;
  readonly endStandardWait: (token: StandardWaitToken) => Promise<void>;
}

const UserInputWaitEventSchema = Schema.Union(
  Schema.Struct({
    state: Schema.Literal("start"),
    id: Schema.NonEmptyString,
  }),
  Schema.Struct({
    state: Schema.Literal("end"),
    id: Schema.NonEmptyString,
  }),
);

export type UserInputWaitEvent = typeof UserInputWaitEventSchema.Type;
export const isUserInputWaitEvent = Schema.is(UserInputWaitEventSchema);

export const installUiWaitObserver = (
  ui: ObservedExtensionUI,
  callbacks: UIWaitObserverCallbacks,
): (() => void) => {
  const ownership = { active: true };
  let nextToken = 0;

  const begin = async (): Promise<StandardWaitToken> => {
    const token = nextToken;
    nextToken += 1;
    if (ownership.active) {
      try {
        await callbacks.beginStandardWait(token);
      } catch {
        // Observer failures must not alter the dialog outcome.
      }
    }
    return token;
  };

  const end = async (token: StandardWaitToken): Promise<void> => {
    if (!ownership.active) return;
    try {
      await callbacks.endStandardWait(token);
    } catch {
      // Observer failures must not alter the dialog outcome.
    }
  };

  const originalSelect = ui.select;
  const originalConfirm = ui.confirm;
  const originalInput = ui.input;
  const originalEditor = ui.editor;

  const wrappedSelect: ObservedExtensionUI["select"] = async (
    title,
    options,
    opts,
  ) => {
    const token = await begin();
    try {
      return await originalSelect.call(ui, title, options, opts);
    } finally {
      await end(token);
    }
  };

  const wrappedConfirm: ObservedExtensionUI["confirm"] = async (
    title,
    message,
    opts,
  ) => {
    const token = await begin();
    try {
      return await originalConfirm.call(ui, title, message, opts);
    } finally {
      await end(token);
    }
  };

  const wrappedInput: ObservedExtensionUI["input"] = async (
    title,
    placeholder,
    opts,
  ) => {
    const token = await begin();
    try {
      return await originalInput.call(ui, title, placeholder, opts);
    } finally {
      await end(token);
    }
  };

  const wrappedEditor: ObservedExtensionUI["editor"] = async (
    title,
    prefill,
  ) => {
    const token = await begin();
    try {
      return await originalEditor.call(ui, title, prefill);
    } finally {
      await end(token);
    }
  };

  ui.select = wrappedSelect;
  ui.confirm = wrappedConfirm;
  ui.input = wrappedInput;
  ui.editor = wrappedEditor;

  return () => {
    if (!ownership.active) return;
    ownership.active = false;
    if (ui.select === wrappedSelect) ui.select = originalSelect;
    if (ui.confirm === wrappedConfirm) ui.confirm = originalConfirm;
    if (ui.input === wrappedInput) ui.input = originalInput;
    if (ui.editor === wrappedEditor) ui.editor = originalEditor;
  };
};
