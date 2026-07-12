import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FullBox } from "./full-box";

const identity = (text: string): string => text;

describe("FullBox", () => {
  it("renders aligned rails at the exact supplied width", () => {
    const color = vi.fn(identity);
    const child = {
      render: vi.fn(() => ["one", "xy"]),
      invalidate: vi.fn(),
    };
    const box = new FullBox(child, { color });

    expect(box.render(7)).toEqual(["┌─────┐", "│one  │", "│xy   │", "└─────┘"]);
    expect(child.render).toHaveBeenCalledWith(5);
    expect(color).toHaveBeenCalledWith("┌─────┐");
    expect(color).toHaveBeenCalledWith("│");
    expect(color).toHaveBeenCalledWith("└─────┘");
  });

  it("truncates ANSI-styled wide content against visible interior width", () => {
    const red = (text: string): string => `\u001B[31m${text}\u001B[39m`;
    const child = {
      render: () => [red("界界界"), "x"],
      invalidate: vi.fn(),
    };
    const box = new FullBox(child, { color: identity });

    const lines = box.render(6);

    expect(lines).toHaveLength(4);
    expect(lines.every((line) => visibleWidth(line) === 6)).toBe(true);
    expect(lines[1]).toContain("界界");
    expect(lines[1]).not.toContain("界界界");
  });

  it("renders safely without a frame when disabled or narrower than three columns", () => {
    const child = {
      render: vi.fn((width: number) => ["abcdef".slice(0, width)]),
      invalidate: vi.fn(),
    };
    const disabled = new FullBox(child, {
      color: identity,
      enabled: () => false,
    });
    const enabled = new FullBox(child, { color: identity });

    expect(disabled.render(4.9)).toEqual(["abcd"]);
    expect(child.render).toHaveBeenLastCalledWith(4);
    expect(enabled.render(2)).toEqual(["ab"]);
    expect(child.render).toHaveBeenLastCalledWith(2);
    expect(enabled.render(Number.NaN)).toEqual([""]);
    expect(child.render).toHaveBeenLastCalledWith(0);
  });

  it("passes normalized width into the frame decision and reports the active frame", () => {
    const child = {
      render: vi.fn((width: number) => ["abcdef".slice(0, width)]),
      invalidate: vi.fn(),
    };
    const enabled = vi.fn((width: number) => width >= 3);
    const frameStates: boolean[] = [];
    const box = new FullBox(child, {
      color: identity,
      enabled,
      onFrameActive: (frameActive) => frameStates.push(frameActive),
    });

    expect(box.render(4.9)).toEqual(["┌──┐", "│ab│", "└──┘"]);
    expect(child.render).toHaveBeenLastCalledWith(2);
    expect(box.render(2.9)).toEqual(["ab"]);
    expect(child.render).toHaveBeenLastCalledWith(2);
    expect(enabled).toHaveBeenNthCalledWith(1, 4);
    expect(enabled).toHaveBeenNthCalledWith(2, 2);
    expect(frameStates).toEqual([true, false]);
  });

  it("delegates input, invalidation, key-release interest, and focus", () => {
    const child = {
      focused: false,
      wantsKeyRelease: true,
      render: () => ["child"],
      handleInput: vi.fn(),
      invalidate: vi.fn(),
    };
    const box = new FullBox(child, {
      color: identity,
      focusTarget: child,
    });

    box.focused = true;
    box.handleInput("DOWN");
    box.invalidate();

    expect(box.focused).toBe(true);
    expect(child.focused).toBe(true);
    expect(box.wantsKeyRelease).toBe(true);
    expect(child.handleInput).toHaveBeenCalledWith("DOWN");
    expect(child.invalidate).toHaveBeenCalledOnce();
  });
});
