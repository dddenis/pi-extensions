import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FullBox } from "./full-box";

const identity = (text: string): string => text;

describe("FullBox", () => {
  it("renders rounded rails with one-cell horizontal padding at the exact supplied width", () => {
    const color = vi.fn(identity);
    const child = {
      render: vi.fn(() => ["one", "xy"]),
      invalidate: vi.fn(),
    };
    const box = new FullBox(child, { color });

    expect(box.render(9)).toEqual([
      "╭───────╮",
      "│ one   │",
      "│ xy    │",
      "╰───────╯",
    ]);
    expect(child.render).toHaveBeenCalledWith(5);
    expect(color).toHaveBeenCalledWith("╭───────╮");
    expect(color).toHaveBeenCalledWith("│");
    expect(color).toHaveBeenCalledWith("╰───────╯");
  });

  it("truncates ANSI-styled wide content against the padded child width", () => {
    const red = (text: string): string => `\u001B[31m${text}\u001B[39m`;
    const child = {
      render: () => [red("界界界"), "x"],
      invalidate: vi.fn(),
    };
    const box = new FullBox(child, { color: identity });

    const lines = box.render(8);

    expect(lines).toHaveLength(4);
    expect(lines.every((line) => visibleWidth(line) === 8)).toBe(true);
    expect(lines[1]).toContain("│ ");
    expect(lines[1]).toContain("界界");
    expect(lines[1]).not.toContain("界界界");
    expect(lines[1]).toMatch(/ │$/u);
  });

  it("renders safely without a frame when disabled or narrower than five columns", () => {
    const child = {
      render: vi.fn((width: number) => ["abcdef".slice(0, width)]),
      invalidate: vi.fn(),
    };
    const disabled = new FullBox(child, {
      color: identity,
      enabled: () => false,
    });
    const enabled = new FullBox(child, { color: identity });

    expect(disabled.render(6.9)).toEqual(["abcdef"]);
    expect(child.render).toHaveBeenLastCalledWith(6);
    expect(enabled.render(4.9)).toEqual(["abcd"]);
    expect(child.render).toHaveBeenLastCalledWith(4);
    expect(enabled.render(Number.NaN)).toEqual([""]);
    expect(child.render).toHaveBeenLastCalledWith(0);
  });

  it("passes normalized width into the five-column frame decision and reports the active frame", () => {
    const child = {
      render: vi.fn((width: number) => ["abcdef".slice(0, width)]),
      invalidate: vi.fn(),
    };
    const enabled = vi.fn(() => true);
    const frameStates: boolean[] = [];
    const box = new FullBox(child, {
      color: identity,
      enabled,
      onFrameActive: (frameActive) => frameStates.push(frameActive),
    });

    expect(box.render(5.9)).toEqual(["╭───╮", "│ a │", "╰───╯"]);
    expect(child.render).toHaveBeenLastCalledWith(1);
    expect(box.render(4.9)).toEqual(["abcd"]);
    expect(child.render).toHaveBeenLastCalledWith(4);
    expect(enabled).toHaveBeenNthCalledWith(1, 5);
    expect(enabled).toHaveBeenNthCalledWith(2, 4);
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
