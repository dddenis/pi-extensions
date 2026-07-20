import { Buffer } from "node:buffer";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

export interface OutputLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

export interface BoundedSnapshot {
  readonly text: string;
  readonly truncated: boolean;
}

export interface BoundedAccumulator {
  readonly append: (chunk: string) => void;
  readonly finish: () => void;
  readonly snapshot: () => BoundedSnapshot;
}

export interface SubagentTaskResult {
  readonly description: string;
  readonly cwd: string;
  readonly status: "completed" | "failed";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly stderr?: string;
}

export const TASK_OUTPUT_LIMITS: OutputLimits = {
  maxBytes: DEFAULT_MAX_BYTES,
  maxLines: DEFAULT_MAX_LINES,
};

export const MODEL_OUTPUT_LIMITS: OutputLimits = {
  maxBytes: DEFAULT_MAX_BYTES,
  maxLines: DEFAULT_MAX_LINES,
};

type SanitizerState =
  | "Text"
  | "Escape"
  | "Csi"
  | "Osc"
  | "OscEscape"
  | "ControlString"
  | "ControlStringEscape";

interface TerminalSanitizer {
  readonly append: (chunk: string, emit: (text: string) => void) => void;
  readonly finish: (emit: (text: string) => void) => void;
}

interface TextMetrics {
  readonly bytes: number;
  readonly lines: number;
  readonly endsWithLineFeed: boolean;
}

interface SectionSkeleton {
  readonly label: string;
  readonly skeleton: string;
  readonly skeletonMetrics: TextMetrics;
}

interface SectionPlan extends SectionSkeleton {
  readonly body: string;
  readonly full: string;
  readonly fullMetrics: TextMetrics;
}

const OUTPUT_MARKERS = [
  "[... output omitted ...]",
  "[omitted]",
  "…",
  ".",
] as const;
const AGGREGATE_OMISSION = "[task output omitted by aggregate limit]";
const HEADER = "Subagent results:";
const DESCRIPTION_MAX_BYTES = 160;
const CWD_MAX_BYTES = 240;

const normalizeLimit = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const normalizeLimits = (limits: OutputLimits): OutputLimits => ({
  maxBytes: normalizeLimit(limits.maxBytes),
  maxLines: normalizeLimit(limits.maxLines),
});

const logicalLineCount = (
  textBytes: number,
  lineFeedCount: number,
  endsWithLineFeed: boolean,
): number => (textBytes === 0 ? 0 : lineFeedCount + (endsWithLineFeed ? 0 : 1));

const measureText = (text: string): TextMetrics => {
  let lineFeedCount = 0;
  for (const character of text) {
    if (character === "\n") lineFeedCount += 1;
  }

  return {
    bytes: Buffer.byteLength(text, "utf8"),
    lines: logicalLineCount(
      Buffer.byteLength(text, "utf8"),
      lineFeedCount,
      text.endsWith("\n"),
    ),
    endsWithLineFeed: text.endsWith("\n"),
  };
};

const fits = (metrics: TextMetrics, limits: OutputLimits): boolean =>
  metrics.bytes <= limits.maxBytes && metrics.lines <= limits.maxLines;

const makeTerminalSanitizer = (): TerminalSanitizer => {
  let state: SanitizerState = "Text";
  let pendingCarriageReturn = false;
  let finished = false;

  const append = (chunk: string, emit: (text: string) => void): void => {
    if (finished) return;
    for (const character of chunk) {
      const code = character.codePointAt(0) ?? 0;

      if (state === "Text" && pendingCarriageReturn) {
        pendingCarriageReturn = false;
        emit("\n");
        if (character === "\n") continue;
      }

      switch (state) {
        case "Text":
          if (character === "\r") pendingCarriageReturn = true;
          else if (character === "\u001b") state = "Escape";
          else if (code === 0x9b) state = "Csi";
          else if (code === 0x9d) state = "Osc";
          else if ([0x90, 0x98, 0x9e, 0x9f].includes(code))
            state = "ControlString";
          else if (
            character === "\t" ||
            character === "\n" ||
            (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))
          )
            emit(character);
          break;
        case "Escape":
          if (character === "[") state = "Csi";
          else if (character === "]") state = "Osc";
          else if (["P", "X", "^", "_"].includes(character))
            state = "ControlString";
          else if (code >= 0x20 && code <= 0x2f) state = "Escape";
          else state = character === "\u001b" ? "Escape" : "Text";
          break;
        case "Csi":
          if (code === 0x9c || (code >= 0x40 && code <= 0x7e)) state = "Text";
          else if (character === "\u001b") state = "Escape";
          break;
        case "Osc":
          if (character === "\u0007" || code === 0x9c) state = "Text";
          else if (character === "\u001b") state = "OscEscape";
          break;
        case "OscEscape":
          if (character === "\\") state = "Text";
          else state = character === "\u001b" ? "OscEscape" : "Osc";
          break;
        case "ControlString":
          if (code === 0x9c) state = "Text";
          else if (character === "\u001b") state = "ControlStringEscape";
          break;
        case "ControlStringEscape":
          if (character === "\\") state = "Text";
          else
            state =
              character === "\u001b" ? "ControlStringEscape" : "ControlString";
          break;
      }
    }
  };

  return {
    append,
    finish: (emit) => {
      if (finished) return;
      finished = true;
      if (state === "Text" && pendingCarriageReturn) emit("\n");
      state = "Text";
      pendingCarriageReturn = false;
    },
  };
};

const selectOutputMarker = (limits: OutputLimits): string => {
  if (limits.maxBytes === 0 || limits.maxLines === 0) return "";

  const markerWithSeparator = OUTPUT_MARKERS.find(
    (candidate) => Buffer.byteLength(candidate, "utf8") + 1 <= limits.maxBytes,
  );
  if (markerWithSeparator !== undefined) return markerWithSeparator;

  return (
    OUTPUT_MARKERS.find(
      (candidate) => Buffer.byteLength(candidate, "utf8") <= limits.maxBytes,
    ) ?? ""
  );
};

const makeAccumulator = (
  mode: "head" | "tail",
  requestedLimits: OutputLimits,
): BoundedAccumulator => {
  const limits = normalizeLimits(requestedLimits);
  const marker = selectOutputMarker(limits);
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const sanitizer = makeTerminalSanitizer();
  let values: Array<string> = [];
  let headIndex = 0;
  let retainedBytes = 0;
  let retainedLineFeeds = 0;
  let lastRetained: string | undefined;
  let truncated = false;

  const retainedCount = (): number => values.length - headIndex;
  const firstRetained = (): string | undefined => values[headIndex];
  const retainedLines = (): number =>
    logicalLineCount(retainedBytes, retainedLineFeeds, lastRetained === "\n");
  const rawFits = (): boolean =>
    retainedBytes <= limits.maxBytes && retainedLines() <= limits.maxLines;
  const markedFits = (): boolean => {
    if (marker === "") return rawFits();
    const hasRetained = retainedCount() > 0;
    const needsSeparator =
      hasRetained &&
      (mode === "head" ? lastRetained !== "\n" : firstRetained() !== "\n");
    const bytes = retainedBytes + markerBytes + (needsSeparator ? 1 : 0);
    const lineFeeds = retainedLineFeeds + (needsSeparator ? 1 : 0);
    const endsWithLineFeed = mode === "tail" && lastRetained === "\n";
    const lines = logicalLineCount(bytes, lineFeeds, endsWithLineFeed);
    return bytes <= limits.maxBytes && lines <= limits.maxLines;
  };

  const push = (character: string): void => {
    values.push(character);
    retainedBytes += Buffer.byteLength(character, "utf8");
    if (character === "\n") retainedLineFeeds += 1;
    lastRetained = character;
  };

  const popBack = (): void => {
    if (values.length <= headIndex) return;
    const character = values.pop();
    if (character === undefined) return;
    retainedBytes -= Buffer.byteLength(character, "utf8");
    if (character === "\n") retainedLineFeeds -= 1;
    lastRetained =
      values.length === headIndex ? undefined : values[values.length - 1];
  };

  const compact = (): void => {
    if (headIndex > 4_096 && headIndex * 2 > values.length) {
      values = values.slice(headIndex);
      headIndex = 0;
    }
  };

  const popFront = (): void => {
    const character = values[headIndex];
    if (character === undefined) return;
    headIndex += 1;
    retainedBytes -= Buffer.byteLength(character, "utf8");
    if (character === "\n") retainedLineFeeds -= 1;
    if (headIndex === values.length) {
      values = [];
      headIndex = 0;
      lastRetained = undefined;
      return;
    }
    compact();
  };

  const emit = (character: string): void => {
    if (mode === "head") {
      if (truncated) return;
      push(character);
      if (rawFits()) return;
      truncated = true;
      while (!markedFits() && retainedCount() > 0) popBack();
      return;
    }

    push(character);
    if (!truncated && rawFits()) return;
    truncated = true;
    while (!markedFits() && retainedCount() > 0) popFront();
  };

  const retainedText = (): string => values.slice(headIndex).join("");

  return {
    append: (chunk) => sanitizer.append(chunk, emit),
    finish: () => sanitizer.finish(emit),
    snapshot: () => {
      const retained = retainedText();
      if (!truncated || marker === "") return { text: retained, truncated };
      if (retained === "") return { text: marker, truncated };

      if (mode === "head") {
        return {
          text:
            lastRetained === "\n"
              ? retained + marker
              : retained + "\n" + marker,
          truncated,
        };
      }

      return {
        text:
          firstRetained() === "\n"
            ? marker + retained
            : marker + "\n" + retained,
        truncated,
      };
    },
  };
};

export const sanitizeTerminalText = (text: string): string => {
  const sanitizer = makeTerminalSanitizer();
  const values: Array<string> = [];
  sanitizer.append(text, (character) => values.push(character));
  sanitizer.finish((character) => values.push(character));
  return values.join("");
};

export const makeHeadAccumulator = (
  limits: OutputLimits = TASK_OUTPUT_LIMITS,
): BoundedAccumulator => makeAccumulator("head", limits);

export const makeTailAccumulator = (
  limits: OutputLimits = TASK_OUTPUT_LIMITS,
): BoundedAccumulator => makeAccumulator("tail", limits);

export const formatProgress = (completed: number, total: number): string =>
  "Subagents: " + String(completed) + "/" + String(total) + " completed";

const makeDisplayLabel = (
  text: string,
  maxBytes: number,
  fallback: string,
): string => {
  const sanitizer = makeTerminalSanitizer();
  const values: Array<string> = [];
  let bytes = 0;
  let hasContent = false;
  let pendingSpace = false;
  let clipped = false;

  const clip = (): void => {
    clipped = true;
    const ellipsisBytes = Buffer.byteLength("…", "utf8");
    while (bytes + ellipsisBytes > maxBytes && values.length > 0) {
      const character = values.pop();
      if (character !== undefined)
        bytes -= Buffer.byteLength(character, "utf8");
    }
    while (values[values.length - 1] === " ") {
      values.pop();
      bytes -= 1;
    }
    values.push("…");
    bytes += ellipsisBytes;
  };

  const emit = (character: string): void => {
    if (clipped) return;
    if (character === " " || character === "\t" || character === "\n") {
      if (hasContent) pendingSpace = true;
      return;
    }

    const separatorBytes = pendingSpace && hasContent ? 1 : 0;
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + separatorBytes + characterBytes > maxBytes) {
      clip();
      return;
    }
    if (separatorBytes === 1) {
      values.push(" ");
      bytes += 1;
    }
    values.push(character);
    bytes += characterBytes;
    hasContent = true;
    pendingSpace = false;
  };

  sanitizer.append(text, emit);
  sanitizer.finish(emit);
  if (!hasContent && !clipped) return fallback;
  return values.join("");
};

const boundedChildText = (text: string, mode: "head" | "tail"): string => {
  const accumulator =
    mode === "head" ? makeHeadAccumulator() : makeTailAccumulator();
  accumulator.append(text);
  accumulator.finish();
  return accumulator.snapshot().text;
};

const failureSuffix = (result: SubagentTaskResult): string => {
  if (result.signal !== null) return " (signal " + result.signal + ")";
  if (result.exitCode !== null && result.exitCode !== 0)
    return " (exit " + String(result.exitCode) + ")";
  return " (execution failure)";
};

const makeSectionSkeleton = (
  index: number,
  description: string,
): SectionSkeleton => {
  const label = "[" + String(index + 1) + "] " + description;
  const skeleton = label + "\n" + AGGREGATE_OMISSION;
  return {
    label,
    skeleton,
    skeletonMetrics: measureText(skeleton),
  };
};

const makeSectionPlan = (
  result: SubagentTaskResult,
  cwd: string,
  skeleton: SectionSkeleton,
): SectionPlan => {
  const stdout = boundedChildText(result.output, "head");
  const bodyParts = [
    "cwd: " + cwd,
    "stdout:",
    stdout === "" ? "(no stdout)" : stdout,
  ];
  if (result.status === "failed") {
    bodyParts.push("stderr:", boundedChildText(result.stderr ?? "", "tail"));
  }
  const body = bodyParts.join("\n");
  const full = skeleton.label + "\n" + body;

  return {
    ...skeleton,
    body,
    full,
    fullMetrics: measureText(full),
  };
};

const renderSectionWithin = (
  section: SectionPlan,
  limits: OutputLimits,
): string => {
  if (fits(section.fullMetrics, limits)) return section.full;

  const prefix = section.label + "\n";
  const prefixMetrics = measureText(prefix);
  const markerMetrics = measureText(AGGREGATE_OMISSION);
  const retained: Array<string> = [];
  let retainedBytes = 0;
  let retainedLineFeeds = 0;
  let retainedLast: string | undefined;

  const candidateFits = (): boolean => {
    const needsSeparator = retained.length > 0 && retainedLast !== "\n";
    const bytes =
      prefixMetrics.bytes +
      retainedBytes +
      (needsSeparator ? 1 : 0) +
      markerMetrics.bytes;
    const lines =
      1 + retainedLineFeeds + (needsSeparator ? 1 : 0) + markerMetrics.lines;
    return bytes <= limits.maxBytes && lines <= limits.maxLines;
  };

  for (const character of section.body) {
    retained.push(character);
    retainedBytes += Buffer.byteLength(character, "utf8");
    if (character === "\n") retainedLineFeeds += 1;
    retainedLast = character;
    if (candidateFits()) continue;

    retained.pop();
    retainedBytes -= Buffer.byteLength(character, "utf8");
    if (character === "\n") retainedLineFeeds -= 1;
    retainedLast = retained[retained.length - 1];
    break;
  }

  const retainedText = retained.join("");
  const separator = retainedText !== "" && retainedLast !== "\n" ? "\n" : "";
  return prefix + retainedText + separator + AGGREGATE_OMISSION;
};

class BoundedTextBuilder {
  readonly parts: Array<string> = [];
  bytes = 0;
  lineFeeds = 0;
  lastCharacter: string | undefined;

  append(text: string): void {
    if (text === "") return;
    this.parts.push(text);
    this.bytes += Buffer.byteLength(text, "utf8");
    for (const character of text) {
      if (character === "\n") this.lineFeeds += 1;
      this.lastCharacter = character;
    }
  }

  lines(): number {
    return logicalLineCount(
      this.bytes,
      this.lineFeeds,
      this.lastCharacter === "\n",
    );
  }

  sectionSeparator(): string {
    return this.lastCharacter === "\n" ? "\n" : "\n\n";
  }

  finish(): string {
    return this.parts.join("");
  }
}

const utf8Prefix = (text: string, maxBytes: number): string => {
  const values: Array<string> = [];
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    values.push(character);
    bytes += characterBytes;
  }
  return values.join("");
};

const assertAggregateInvariant = (
  text: string,
  trackedLines: number,
  limits: OutputLimits,
): void => {
  if (
    Buffer.byteLength(text, "utf8") > limits.maxBytes ||
    trackedLines > limits.maxLines
  )
    throw new Error("Subagent aggregate exceeded its output limits");
};

const formatOmittedAggregate = (
  statusLines: ReadonlyArray<string>,
  statusLineBytes: ReadonlyArray<number>,
  limits: OutputLimits,
): string => {
  const total = statusLines.length;
  const outputNotice =
    "[" + String(total) + " task output sections omitted by aggregate limit]";
  const headerBytes = Buffer.byteLength(HEADER, "utf8");
  const outputNoticeBytes = Buffer.byteLength(outputNotice, "utf8");
  let statusPrefixBytes = 0;
  let selectedPrefix = -1;

  for (let prefixLength = 0; prefixLength <= total; prefixLength += 1) {
    if (prefixLength > 0) {
      const nextBytes = statusLineBytes[prefixLength - 1];
      if (nextBytes !== undefined) statusPrefixBytes += 1 + nextBytes;
    }
    const omitted = total - prefixLength;
    const statusNotice =
      omitted > 0
        ? "[" + String(omitted) + " task statuses omitted]"
        : undefined;
    const bytes =
      headerBytes +
      statusPrefixBytes +
      (statusNotice === undefined
        ? 0
        : 1 + Buffer.byteLength(statusNotice, "utf8")) +
      1 +
      outputNoticeBytes;
    const lines = 1 + prefixLength + (statusNotice === undefined ? 0 : 1) + 1;
    if (bytes <= limits.maxBytes && lines <= limits.maxLines)
      selectedPrefix = prefixLength;
  }

  if (selectedPrefix < 0) {
    if (limits.maxBytes === 0 || limits.maxLines === 0) return "";
    return utf8Prefix(
      "[" + String(total) + " task statuses and output sections omitted]",
      limits.maxBytes,
    );
  }

  const builder = new BoundedTextBuilder();
  builder.append(HEADER);
  for (let index = 0; index < selectedPrefix; index += 1) {
    const statusLine = statusLines[index];
    if (statusLine !== undefined) {
      builder.append("\n");
      builder.append(statusLine);
    }
  }
  const omitted = total - selectedPrefix;
  if (omitted > 0) {
    builder.append("\n");
    builder.append("[" + String(omitted) + " task statuses omitted]");
  }
  builder.append("\n");
  builder.append(outputNotice);
  const text = builder.finish();
  assertAggregateInvariant(text, builder.lines(), limits);
  return text;
};

export const formatSubagentResults = (
  results: ReadonlyArray<SubagentTaskResult>,
  requestedLimits: OutputLimits = MODEL_OUTPUT_LIMITS,
): string => {
  const limits = normalizeLimits(requestedLimits);
  if (results.length === 0) {
    if (limits.maxBytes === 0 || limits.maxLines === 0) return "";
    return utf8Prefix(HEADER, limits.maxBytes);
  }

  const descriptions = results.map((result) =>
    makeDisplayLabel(
      result.description,
      DESCRIPTION_MAX_BYTES,
      "(unnamed task)",
    ),
  );
  const statusLines = results.map((result, index) => {
    const description = descriptions[index] ?? "(unnamed task)";
    return (
      String(index + 1) +
      ". " +
      result.status +
      " — " +
      description +
      (result.status === "failed" ? failureSuffix(result) : "")
    );
  });
  const statusLineBytes = statusLines.map((line) =>
    Buffer.byteLength(line, "utf8"),
  );
  const sectionSkeletons = results.map((_result, index) =>
    makeSectionSkeleton(index, descriptions[index] ?? "(unnamed task)"),
  );

  let statusBytes = Buffer.byteLength(HEADER, "utf8");
  for (const lineBytes of statusLineBytes) statusBytes += 1 + lineBytes;
  const statusLinesCount = 1 + statusLines.length;
  const suffixSkeletonBytes = Array.from(
    { length: sectionSkeletons.length + 1 },
    () => 0,
  );
  const suffixSkeletonLines = Array.from(
    { length: sectionSkeletons.length + 1 },
    () => 0,
  );
  for (let index = sectionSkeletons.length - 1; index >= 0; index -= 1) {
    const skeleton = sectionSkeletons[index];
    if (skeleton === undefined) continue;
    suffixSkeletonBytes[index] =
      2 +
      skeleton.skeletonMetrics.bytes +
      (suffixSkeletonBytes[index + 1] ?? 0);
    suffixSkeletonLines[index] =
      1 +
      skeleton.skeletonMetrics.lines +
      (suffixSkeletonLines[index + 1] ?? 0);
  }

  const minimumBytes = statusBytes + (suffixSkeletonBytes[0] ?? 0);
  const minimumLines = statusLinesCount + (suffixSkeletonLines[0] ?? 0);
  if (minimumBytes > limits.maxBytes || minimumLines > limits.maxLines)
    return formatOmittedAggregate(statusLines, statusLineBytes, limits);

  const builder = new BoundedTextBuilder();
  builder.append(HEADER);
  for (const statusLine of statusLines) {
    builder.append("\n");
    builder.append(statusLine);
  }

  for (let index = 0; index < sectionSkeletons.length; index += 1) {
    const skeleton = sectionSkeletons[index];
    const result = results[index];
    if (skeleton === undefined || result === undefined) continue;
    const remainingTasks = sectionSkeletons.length - index;
    const separator = builder.sectionSeparator();
    const separatorBytes = Buffer.byteLength(separator, "utf8");
    const laterBytes = suffixSkeletonBytes[index + 1] ?? 0;
    const laterLines = suffixSkeletonLines[index + 1] ?? 0;
    const discretionaryBytes =
      limits.maxBytes -
      builder.bytes -
      separatorBytes -
      skeleton.skeletonMetrics.bytes -
      laterBytes;
    const discretionaryLines =
      limits.maxLines -
      builder.lines() -
      1 -
      skeleton.skeletonMetrics.lines -
      laterLines;
    const sectionLimits: OutputLimits = {
      maxBytes:
        skeleton.skeletonMetrics.bytes +
        Math.floor(discretionaryBytes / remainingTasks),
      maxLines:
        skeleton.skeletonMetrics.lines +
        Math.floor(discretionaryLines / remainingTasks),
    };
    const rendered =
      sectionLimits.maxBytes === skeleton.skeletonMetrics.bytes ||
      sectionLimits.maxLines === skeleton.skeletonMetrics.lines
        ? skeleton.skeleton
        : renderSectionWithin(
            makeSectionPlan(
              result,
              makeDisplayLabel(result.cwd, CWD_MAX_BYTES, "(unavailable cwd)"),
              skeleton,
            ),
            sectionLimits,
          );
    builder.append(separator);
    builder.append(rendered);
  }

  const text = builder.finish();
  assertAggregateInvariant(text, builder.lines(), limits);
  return text;
};
