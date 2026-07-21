import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface FooterUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: { readonly total: number };
}

export interface FooterEntry {
  readonly type: string;
  readonly message?: {
    readonly role: string;
    readonly usage?: FooterUsage;
  };
  readonly usage?: FooterUsage;
}

export interface FooterContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

export interface FooterModel {
  readonly id: string;
  readonly provider: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
}

export interface FooterRenderInput {
  readonly cwd: string;
  readonly homeDirectory?: string;
  readonly entries: ReadonlyArray<FooterEntry>;
  readonly branch?: string;
  readonly sessionName?: string;
  readonly contextUsage?: FooterContextUsage;
  readonly model?: FooterModel;
  readonly thinkingLevel?: string;
  readonly availableProviderCount: number;
  readonly extensionStatuses: ReadonlyMap<string, string>;
  readonly rateLimitStatus?: string;
  readonly usingSubscription: boolean;
  readonly autoCompactEnabled: boolean;
}

export type FooterTone = "dim" | "warning" | "error";

export interface FooterSegment {
  readonly text: string;
  readonly tone: FooterTone;
}

export interface FooterRenderData {
  readonly location: string;
  readonly stats: ReadonlyArray<FooterSegment>;
  readonly model: string;
  readonly modelWithProvider?: string;
  readonly statuses: ReadonlyArray<string>;
}

export interface FooterPalette {
  readonly dim: (text: string) => string;
  readonly warning: (text: string) => string;
  readonly error: (text: string) => string;
}

export const sanitizeFooterText = (text: string): string =>
  text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();

export const formatFooterTokens = (count: number): string => {
  if (count < 1_000) return Math.round(count).toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
};

const formatCwd = (cwd: string, homeDirectory?: string): string => {
  if (homeDirectory === undefined || homeDirectory.length === 0) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(homeDirectory);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
};

const safeNumber = (value: number): number =>
  Number.isFinite(value) ? value : 0;

const stripOpenAiPrefix = (status: string): string =>
  sanitizeFooterText(status).replace(/^OpenAI(?: limits)?\s*/i, "");

const contextSegment = (input: FooterRenderInput): FooterSegment => {
  const contextWindow =
    input.contextUsage?.contextWindow ?? input.model?.contextWindow ?? 0;
  const auto = input.autoCompactEnabled ? " auto" : "";
  const usedPercent = input.contextUsage?.percent;

  if (usedPercent === undefined || usedPercent === null) {
    return {
      text: `? (${formatFooterTokens(contextWindow)}${auto})`,
      tone: "dim",
    };
  }

  const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
  return {
    text: `${remaining.toFixed(1)}% (${formatFooterTokens(contextWindow)}${auto})`,
    tone: remaining <= 10 ? "error" : remaining <= 30 ? "warning" : "dim",
  };
};

export const buildFooterRenderData = (
  input: FooterRenderInput,
): FooterRenderData => {
  let location = sanitizeFooterText(formatCwd(input.cwd, input.homeDirectory));
  const branch =
    input.branch === undefined ? "" : sanitizeFooterText(input.branch);
  if (branch.length > 0) location = `${location} (${branch})`;
  const sessionName =
    input.sessionName === undefined
      ? ""
      : sanitizeFooterText(input.sessionName);
  if (sessionName.length > 0) location = `${location} • ${sessionName}`;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let latestCacheHitRate: number | undefined;

  for (const entry of input.entries) {
    const message = entry.type === "message" ? entry.message : undefined;
    const assistantUsage =
      message?.role === "assistant" ? message.usage : undefined;
    const usage =
      assistantUsage ??
      (message?.role === "toolResult" ? message.usage : undefined) ??
      (entry.type === "compaction" || entry.type === "branch_summary"
        ? entry.usage
        : undefined);
    if (usage === undefined) continue;

    totalInput += safeNumber(usage.input);
    totalOutput += safeNumber(usage.output);
    totalCacheRead += safeNumber(usage.cacheRead);
    totalCacheWrite += safeNumber(usage.cacheWrite);
    totalCost += safeNumber(usage.cost.total);
    if (assistantUsage === undefined) continue;

    const promptTokens =
      safeNumber(assistantUsage.input) +
      safeNumber(assistantUsage.cacheRead) +
      safeNumber(assistantUsage.cacheWrite);
    latestCacheHitRate =
      promptTokens > 0
        ? (safeNumber(assistantUsage.cacheRead) / promptTokens) * 100
        : undefined;
  }

  const stats: FooterSegment[] = [];
  const addDimStat = (text: string) => stats.push({ text, tone: "dim" });
  if (totalInput !== 0) addDimStat(`↑${formatFooterTokens(totalInput)}`);
  if (totalOutput !== 0) addDimStat(`↓${formatFooterTokens(totalOutput)}`);
  if (totalCacheRead !== 0)
    addDimStat(`R${formatFooterTokens(totalCacheRead)}`);
  if (totalCacheWrite !== 0)
    addDimStat(`W${formatFooterTokens(totalCacheWrite)}`);
  if (
    (totalCacheRead !== 0 || totalCacheWrite !== 0) &&
    latestCacheHitRate !== undefined
  ) {
    addDimStat(`CH${latestCacheHitRate.toFixed(1)}%`);
  }
  if (totalCost !== 0 || input.usingSubscription) {
    addDimStat(
      `$${totalCost.toFixed(3)}${input.usingSubscription ? " (sub)" : ""}`,
    );
  }
  stats.push(contextSegment(input));

  if (input.rateLimitStatus !== undefined) {
    const rateStatus = stripOpenAiPrefix(input.rateLimitStatus);
    if (rateStatus.length > 0) addDimStat(rateStatus);
  }

  const modelName =
    input.model === undefined ? "no-model" : sanitizeFooterText(input.model.id);
  const thinkingLevel =
    sanitizeFooterText(input.thinkingLevel ?? "off") || "off";
  const model =
    input.model?.reasoning === true
      ? `${modelName} • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}`
      : modelName;
  const modelWithProvider =
    input.availableProviderCount > 1 && input.model !== undefined
      ? `(${sanitizeFooterText(input.model.provider)}) ${model}`
      : undefined;

  const statuses = [...input.extensionStatuses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, status]) => sanitizeFooterText(status))
    .filter((status) => status.length > 0);

  return {
    location,
    stats,
    model,
    ...(modelWithProvider === undefined ? {} : { modelWithProvider }),
    statuses,
  };
};

const styleSegment = (segment: FooterSegment, palette: FooterPalette): string =>
  palette[segment.tone](segment.text);

const styleStats = (
  stats: ReadonlyArray<FooterSegment>,
  palette: FooterPalette,
): string =>
  stats
    .map(
      (segment, index) =>
        `${index === 0 ? "" : palette.dim(" ")}${styleSegment(segment, palette)}`,
    )
    .join("");

export const renderFooter = (
  data: FooterRenderData,
  requestedWidth: number,
  palette: FooterPalette,
): string[] => {
  const width = Math.max(0, Math.floor(requestedWidth));
  const ellipsis = palette.dim("...");
  const locationLine = truncateToWidth(
    palette.dim(data.location),
    width,
    ellipsis,
  );

  let statsLeft = styleStats(data.stats, palette);
  let statsWidth = visibleWidth(statsLeft);
  if (statsWidth > width) {
    statsLeft = truncateToWidth(statsLeft, width, ellipsis);
    statsWidth = visibleWidth(statsLeft);
  }

  const minimumPadding = 2;
  let right = data.model;
  if (
    data.modelWithProvider !== undefined &&
    statsWidth + minimumPadding + visibleWidth(data.modelWithProvider) <= width
  ) {
    right = data.modelWithProvider;
  }

  const rightWidth = visibleWidth(right);
  const totalNeeded = statsWidth + minimumPadding + rightWidth;
  let statsLine: string;
  if (totalNeeded <= width) {
    const padding = " ".repeat(width - statsWidth - rightWidth);
    statsLine = `${statsLeft}${palette.dim(padding)}${palette.dim(right)}`;
  } else {
    const availableForRight = width - statsWidth - minimumPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(right, availableForRight, "");
      const padding = " ".repeat(
        Math.max(0, width - statsWidth - visibleWidth(truncatedRight)),
      );
      statsLine = `${statsLeft}${palette.dim(padding)}${palette.dim(truncatedRight)}`;
    } else {
      statsLine = statsLeft;
    }
  }

  const lines = [locationLine, truncateToWidth(statsLine, width, "")];
  if (data.statuses.length > 0) {
    lines.push(
      truncateToWidth(palette.dim(data.statuses.join(" ")), width, ellipsis),
    );
  }
  return lines;
};
