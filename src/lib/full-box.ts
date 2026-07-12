import {
  type Component,
  type Focusable,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const FULL_BOX_HORIZONTAL_PADDING = 1;

export const FULL_BOX_MINIMUM_FRAME_WIDTH = 5;

const normalizeWidth = (width: number): number =>
  Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;

export const fullBoxFrameWidthEnabled = (width: number): boolean =>
  normalizeWidth(width) >= FULL_BOX_MINIMUM_FRAME_WIDTH;

export interface FullBoxOptions {
  readonly color: (text: string) => string;
  readonly enabled?: (width: number) => boolean;
  readonly focusTarget?: Focusable;
  readonly onFrameActive?: (frameActive: boolean) => void;
}

export class FullBox<T extends Component> implements Component, Focusable {
  private readonly color: (text: string) => string;
  private readonly enabled: (width: number) => boolean;
  private readonly focusTarget: Focusable | undefined;
  private readonly onFrameActive: ((frameActive: boolean) => void) | undefined;
  private isFocused = false;

  constructor(
    readonly child: T,
    options: FullBoxOptions,
  ) {
    this.color = options.color;
    this.enabled = options.enabled ?? (() => true);
    this.focusTarget = options.focusTarget;
    this.onFrameActive = options.onFrameActive;
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(focused: boolean) {
    this.isFocused = focused;
    if (this.focusTarget !== undefined) {
      this.focusTarget.focused = focused;
    }
  }

  get wantsKeyRelease(): boolean {
    return this.child.wantsKeyRelease ?? false;
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    const frameActive =
      this.enabled(safeWidth) && fullBoxFrameWidthEnabled(safeWidth);
    this.onFrameActive?.(frameActive);
    if (!frameActive) {
      return this.child
        .render(safeWidth)
        .map((line) => truncateToWidth(line, safeWidth, ""));
    }

    const contentWidth = safeWidth - 2 - FULL_BOX_HORIZONTAL_PADDING * 2;
    const horizontal = "─".repeat(safeWidth - 2);
    const sidePadding = " ".repeat(FULL_BOX_HORIZONTAL_PADDING);
    const content = this.child.render(contentWidth).map((line) => {
      const truncated = truncateToWidth(line, contentWidth, "");
      const linePadding = " ".repeat(
        Math.max(0, contentWidth - visibleWidth(truncated)),
      );
      return `${this.color("│")}${sidePadding}${truncated}${linePadding}${sidePadding}${this.color("│")}`;
    });

    return [
      this.color(`╭${horizontal}╮`),
      ...content,
      this.color(`╰${horizontal}╯`),
    ];
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }

  invalidate(): void {
    this.child.invalidate();
  }
}
