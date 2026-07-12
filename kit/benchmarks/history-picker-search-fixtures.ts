import type { HistoryItem } from "../../src/history-picker/types";

const item = (text: string, timestamp: number): HistoryItem => ({
  text,
  timestamp,
  cwd: "/benchmark",
  sessionFile: `/benchmark/${timestamp}.jsonl`,
  source: "saved",
});

const observedLength = (index: number): number => {
  if (index < 463) return 47;
  if (index < 880) return 48 + Math.floor(((index - 463) * 394) / 416);
  if (index < 925) return 1_533;
  return 119_732;
};

export const observedCorpusFixture = (): ReadonlyArray<HistoryItem> => {
  const unique = Array.from({ length: 926 }, (_, index) => {
    const length = observedLength(index);
    if (index === 925) return item(`x${"a".repeat(length - 1)}`, index);

    const prefix = `prompt-${index} `;
    return item(
      `${prefix}${"x".repeat(Math.max(0, length - prefix.length))}`,
      index,
    );
  });
  return Array.from({ length: 1_477 }, (_, index) => index).flatMap((index) => {
    const entry = unique[index % unique.length];
    return entry === undefined ? [] : [{ ...entry }];
  });
};

export const shortPromptFixture = (): ReadonlyArray<HistoryItem> =>
  Array.from({ length: 5_000 }, (_, index) =>
    item(`deploy project ${index} with blue widget`, index),
  );

export const oversizedPreparationFixture = (): ReadonlyArray<HistoryItem> => [
  item("a".repeat(2 * 1024 * 1024), 10_000),
];

export const adversarialFixture = (): ReadonlyArray<HistoryItem> => [
  item("a".repeat(120_000), 1),
  item("ab".repeat(60_000), 2),
  item(`${"x".repeat(60_000)} needle ${"y".repeat(60_000)}`, 3),
];
