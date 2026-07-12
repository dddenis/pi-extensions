import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Runtime } from "effect";
import { expect } from "vitest";
import {
  HistorySearchEngine,
  makeHistorySearchEngineLayer,
  makeHistorySearchEngineTestLayer,
  type HistorySearchBatchEvent,
  type PreparedHistoryCorpus,
} from "./history-search-engine";
import { HISTORY_SEARCH_LIMITS } from "./history-search-normalization";
import type { HistoryItem, HistoryScope } from "./types";

const item = (text: string, timestamp: number, cwd = "/a"): HistoryItem => ({
  text,
  timestamp,
  cwd,
  sessionFile: `/sessions/${timestamp}-${text.length}.jsonl`,
  source: "saved",
});

const run = (
  items: ReadonlyArray<HistoryItem>,
  query: string,
  scope: HistoryScope = "all",
) =>
  Effect.gen(function* () {
    const engine = yield* HistorySearchEngine;
    const corpus = yield* engine.prepare(items);
    return yield* engine.search(corpus, { query, scope, currentCwd: "/a" });
  });

const providedRun = (
  items: ReadonlyArray<HistoryItem>,
  query: string,
  scope: HistoryScope = "all",
) =>
  run(items, query, scope).pipe(Effect.provide(makeHistorySearchEngineLayer()));

type FuzzyCutKind = "line" | "sentence" | "whitespace" | "hard";
type FuzzyCutPosition = "before" | "on" | "after";

const fuzzyBoundaryFixture = (
  kind: FuzzyCutKind,
  position: FuzzyCutPosition,
): {
  readonly text: string;
  readonly alphaStart: number;
  readonly omegaStart: number;
} => {
  const cut = kind === "hard" ? 512 : 480;
  const marker =
    kind === "line"
      ? { start: cut - 1, text: "\n" }
      : kind === "sentence"
        ? { start: cut - 2, text: ". " }
        : kind === "whitespace"
          ? { start: cut - 1, text: " " }
          : undefined;
  const alphaStart =
    position === "before"
      ? cut - 145
      : position === "on"
        ? cut - 100
        : cut + 20;
  const omegaStart = alphaStart + 120;
  const characters = Array.from({ length: 720 }, () => "x");

  if (marker !== undefined) {
    characters.splice(marker.start, marker.text.length, ...marker.text);
  }
  characters.splice(alphaStart, 5, ..."alpha");
  characters.splice(omegaStart, 5, ..."omega");

  return { text: characters.join(""), alphaStart, omegaStart };
};

describe("history search engine", () => {
  it.effect("orders every tier ahead of weaker evidence", () =>
    providedRun(
      [
        item("beta", 1),
        item("beta suffix", 100),
        item("xxbetaxx", 200),
        item("Build Every Test Again", 300),
      ],
      "beta",
    ).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.results.map((result) => result.matchTier)).toEqual([
            "exact",
            "word-boundary",
            "substring",
            "fuzzy",
          ]);
        }),
      ),
    ),
  );

  it.effect("filters scope before exact raw deduplication", () =>
    providedRun(
      [item("same", 100, "/b"), item("same", 10, "/a"), item("Same", 20, "/a")],
      "",
      "current-project",
    ).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.results.map(({ item }) => item.text)).toEqual([
            "Same",
            "same",
          ]);
          expect(outcome.results[1]?.item.timestamp).toBe(10);
          expect(
            outcome.results.every((result) => result.matchTier === undefined),
          ).toBe(true);
          expect(
            outcome.results.every(
              (result) => result.matchEvidence === undefined,
            ),
          ).toBe(true);
        }),
      ),
    ),
  );

  it.effect("interrupts non-empty search during eligibility filtering", () => {
    const eligibilityBatchSizes: Array<number> = [];
    const items = Array.from({ length: 4_096 }, (_, index) =>
      item(`history entry ${index}`, index),
    );

    return Effect.gen(function* () {
      const engine = yield* HistorySearchEngine;
      const corpus = yield* engine.prepare(items);
      const search = yield* Effect.fork(
        engine.search(corpus, {
          query: "needle",
          scope: "all",
          currentCwd: "/a",
        }),
      );

      for (
        let attempts = 0;
        attempts < 20 && eligibilityBatchSizes.length === 0;
        attempts += 1
      ) {
        yield* Effect.yieldNow();
      }
      expect(eligibilityBatchSizes).toEqual([64]);

      const exit = yield* Fiber.interrupt(search);
      expect(
        exit._tag === "Failure" && Cause.isInterruptedOnly(exit.cause),
      ).toBe(true);
      expect(
        eligibilityBatchSizes.reduce((sum, size) => sum + size, 0),
      ).toBeLessThan(items.length);
    }).pipe(
      Effect.provide(
        makeHistorySearchEngineTestLayer({
          onEligibilityBatch: (size) => eligibilityBatchSizes.push(size),
        }),
      ),
    );
  });

  it.effect("interrupts empty-query search during bounded ordering", () => {
    const emptyQueryBatchSizes: Array<number> = [];
    const items = Array.from({ length: 4_096 }, (_, index) =>
      item(`history entry ${index}`, index),
    );

    return Effect.gen(function* () {
      const engine = yield* HistorySearchEngine;
      const corpus = yield* engine.prepare(items);
      const search = yield* Effect.fork(
        engine.search(corpus, {
          query: "",
          scope: "all",
          currentCwd: "/a",
        }),
      );

      for (
        let attempts = 0;
        attempts < 300 && emptyQueryBatchSizes.length === 0;
        attempts += 1
      ) {
        yield* Effect.yieldNow();
      }
      expect(emptyQueryBatchSizes).toEqual([64]);

      const exit = yield* Fiber.interrupt(search);
      expect(
        exit._tag === "Failure" && Cause.isInterruptedOnly(exit.cause),
      ).toBe(true);
      expect(
        emptyQueryBatchSizes.reduce((sum, size) => sum + size, 0),
      ).toBeLessThan(items.length);
    }).pipe(
      Effect.provide(
        makeHistorySearchEngineTestLayer({
          onEmptyQueryBatch: (size) => emptyQueryBatchSizes.push(size),
        }),
      ),
    );
  });

  it("interrupts oversized preparation from a host timer", async () => {
    const events: Array<HistorySearchBatchEvent> = [];
    const oversized = item("a".repeat(1024 * 1024), 1);

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* HistorySearchEngine;
        const runtime = yield* Effect.runtime<never>();
        const preparation = yield* Effect.fork(engine.prepare([oversized]));

        const exit = yield* Effect.promise(
          () =>
            new Promise<Exit.Exit<PreparedHistoryCorpus, never>>((resolve) => {
              setTimeout(() => {
                void Runtime.runPromise(runtime)(
                  Fiber.interrupt(preparation),
                ).then(resolve);
              }, 0);
            }),
        );

        expect(
          exit._tag === "Failure" && Cause.isInterruptedOnly(exit.cause),
        ).toBe(true);
        expect(events.some((event) => event.phase === "prepare-record")).toBe(
          false,
        );
      }).pipe(
        Effect.provide(
          makeHistorySearchEngineLayer((event) => events.push(event)),
        ),
      ),
    );
  });

  it("yields to a host timer before an oversized record is prepared", async () => {
    let preparationCompleted = false;
    const oversized = item("a".repeat(512 * 1024), 1);
    const preparation = Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* HistorySearchEngine;
        yield* engine.prepare([oversized]);
      }).pipe(Effect.provide(makeHistorySearchEngineLayer())),
    ).finally(() => {
      preparationCompleted = true;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(preparationCompleted).toBe(false);
    await preparation;
  });

  it.effect("uses direct search across a hard segment boundary", () => {
    const text = `${"x".repeat(510)}needle${"y".repeat(20)}`;
    return providedRun([item(text, 1)], "needle").pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.results[0]?.matchTier).toBe("substring");
          expect(outcome.results[0]?.matchEvidence?.focusRange).toEqual({
            start: 510,
            end: 516,
          });
        }),
      ),
    );
  });

  it.effect(
    "finds equivalent local fuzzy evidence before, on, and after every cut kind",
    () => {
      const cutKinds: ReadonlyArray<FuzzyCutKind> = [
        "line",
        "sentence",
        "whitespace",
        "hard",
      ];
      const positions: ReadonlyArray<FuzzyCutPosition> = [
        "before",
        "on",
        "after",
      ];

      return Effect.forEach(
        cutKinds.flatMap((kind) =>
          positions.map((position) => ({ kind, position })),
        ),
        ({ kind, position }) => {
          const fixture = fuzzyBoundaryFixture(kind, position);
          const label = `${kind} cut, evidence ${position}`;

          return providedRun([item(fixture.text, 1)], "alph omeg").pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                expect(outcome.results, label).toHaveLength(1);
                expect(outcome.results[0]?.matchTier, label).toBe("fuzzy");
                expect(outcome.results[0]?.item.text, label).toBe(fixture.text);
                expect(
                  outcome.results[0]?.matchEvidence?.sourceRanges,
                  label,
                ).toEqual([
                  { start: fixture.alphaStart, end: fixture.alphaStart + 4 },
                  { start: fixture.omegaStart, end: fixture.omegaStart + 4 },
                ]);
                expect(
                  outcome.results[0]?.matchEvidence?.focusRange,
                  label,
                ).toEqual({
                  start: fixture.alphaStart,
                  end: fixture.omegaStart + 4,
                });
              }),
            ),
          );
        },
        { discard: true },
      );
    },
  );

  it.effect(
    "maps fuzzy evidence through normalization across an overlapping line cut",
    () => {
      const alphaStart = 380;
      const markerStart = 479;
      const omegaStart = 502;
      const characters = Array.from({ length: 720 }, () => "x");
      characters.splice(alphaStart, 6, ..."a\u0301lpha");
      characters.splice(markerStart, 3, ..."\r\n\t");
      characters.splice(omegaStart, 5, ..."omega");
      const text = characters.join("");

      return providedRun([item(text, 1)], "alph omeg").pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            expect(outcome.results).toHaveLength(1);
            expect(outcome.results[0]?.matchTier).toBe("fuzzy");
            expect(outcome.results[0]?.matchEvidence).toEqual({
              sourceRanges: [
                { start: alphaStart, end: alphaStart + 5 },
                { start: omegaStart, end: omegaStart + 4 },
              ],
              focusRange: { start: alphaStart, end: omegaStart + 4 },
            });
          }),
        ),
      );
    },
  );

  it.effect("caps retained results and reports omitted matches", () =>
    providedRun(
      Array.from({ length: 250 }, (_, index) =>
        item(`needle-${String(index).padStart(3, "0")}`, index),
      ),
      "needle",
    ).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.results).toHaveLength(200);
          expect(outcome.hasMoreResults).toBe(true);
        }),
      ),
    ),
  );

  it.effect("uses direct-only search beyond the fuzzy query limit", () =>
    providedRun(
      [item(`prefix ${"q".repeat(257)} suffix`, 1), item("q scattered", 2)],
      "q".repeat(257),
    ).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.results).toHaveLength(1);
          expect(outcome.results[0]?.matchTier).toBe("word-boundary");
          expect(outcome.fuzzySkippedForLongQuery).toBe(true);
        }),
      ),
    ),
  );

  it.effect("breaks tier ties by timestamp and lexical raw text", () =>
    providedRun(
      [item("z beta", 20), item("a beta", 20), item("m beta", 30)],
      "beta",
    ).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.results.map(({ item }) => item.text)).toEqual([
            "m beta",
            "a beta",
            "z beta",
          ]);
        }),
      ),
    ),
  );

  it.effect(
    "chooses shortest then earliest equal-quality overlap evidence",
    () => {
      const text = `${"a".repeat(500)} blue widget ${"b".repeat(500)}`;
      return providedRun([item(text, 1)], "blue wid").pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            const focus = outcome.results[0]?.matchEvidence?.focusRange;
            expect(focus?.start).toBe(501);
            expect(focus?.end).toBeLessThanOrEqual(512 + 64 + 512);
          }),
        ),
      );
    },
  );

  it.effect("normalizes Unicode and maps direct evidence to raw text", () =>
    providedRun(
      [
        item("CAFÉ", 1),
        item("Cafe\u0301", 2),
        item("İstanbul", 3),
        item("中文 😀", 4),
        item("alpha\r\n\t\u001bbeta", 5),
      ],
      "cafe",
    ).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.results.map(({ item }) => item.text)).toEqual([
            "Cafe\u0301",
            "CAFÉ",
          ]);
          expect(outcome.results[0]?.matchEvidence?.focusRange).toEqual({
            start: 0,
            end: 5,
          });
        }),
      ),
      Effect.zipRight(
        providedRun([item("İstanbul", 1)], "istanbul").pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              expect(outcome.results[0]?.matchEvidence?.focusRange).toEqual({
                start: 0,
                end: 8,
              });
            }),
          ),
        ),
      ),
      Effect.zipRight(
        providedRun([item("中文 😀", 1)], "中文 😀").pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              expect(outcome.results[0]?.matchTier).toBe("exact");
              expect(outcome.results[0]?.matchEvidence?.focusRange).toEqual({
                start: 0,
                end: 5,
              });
            }),
          ),
        ),
      ),
      Effect.zipRight(
        providedRun([item("alpha\r\n\t\u001bbeta", 1)], "alpha beta").pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              expect(outcome.results[0]?.matchTier).toBe("exact");
              expect(outcome.results[0]?.matchEvidence?.focusRange).toEqual({
                start: 0,
                end: 13,
              });
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("rejects poor smart-fuzzy matches", () =>
    providedRun([item("deploy blue widget", 1)], "zzzz poor scattered").pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.results).toEqual([]);
        }),
      ),
    ),
  );

  it.effect("discards all fuzzy candidates when a later batch throws", () => {
    const fuzzyBatchIndexes: Array<number> = [];
    let fuzzyFailureReached = false;
    let observedYieldAfterFailure = false;
    const waitForFuzzyFailure = (): Effect.Effect<void> =>
      Effect.suspend(() =>
        fuzzyFailureReached
          ? Effect.sync(() => {
              observedYieldAfterFailure = true;
            })
          : Effect.yieldNow().pipe(Effect.zipRight(waitForFuzzyFailure())),
      );
    const items = [
      item("Build Every Test Again", 1),
      ...Array.from({ length: 63 }, (_, index) =>
        item(`unrelated ${index}`, index + 2),
      ),
      item("beta direct", 100),
    ];

    const baseline = providedRun(items, "beta").pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(
            outcome.results.some(
              (result) =>
                result.item.text === "Build Every Test Again" &&
                result.matchTier === "fuzzy",
            ),
          ).toBe(true);
        }),
      ),
    );
    const degraded = Effect.gen(function* () {
      const engine = yield* HistorySearchEngine;
      const corpus = yield* engine.prepare(items);
      const failureWatcher = yield* Effect.fork(waitForFuzzyFailure());
      const outcome = yield* engine.search(corpus, {
        query: "beta",
        scope: "all",
        currentCwd: "/a",
      });

      expect(fuzzyBatchIndexes).toEqual([0, 1]);
      expect(outcome.results.map(({ item }) => item.text)).toEqual([
        "beta direct",
      ]);
      expect(outcome.results[0]?.matchTier).toBe("word-boundary");
      expect(outcome.warning).toBe("Fuzzy history search unavailable");
      expect(observedYieldAfterFailure).toBe(true);
      yield* Fiber.interrupt(failureWatcher);
    }).pipe(
      Effect.provide(
        makeHistorySearchEngineTestLayer({
          beforeFuzzyBatch: (batchIndex) => {
            fuzzyBatchIndexes.push(batchIndex);
            if (batchIndex === 1) {
              fuzzyFailureReached = true;
              throw new Error("forced fuzzy failure");
            }
          },
        }),
      ),
    );
    return baseline.pipe(Effect.zipRight(degraded));
  });

  it.effect("runs fuzzy search at 256 code units and skips it at 257", () => {
    const events: Array<HistorySearchBatchEvent> = [];
    const layer = makeHistorySearchEngineLayer((event) => events.push(event));
    return Effect.gen(function* () {
      const engine = yield* HistorySearchEngine;
      const corpus = yield* engine.prepare([
        item("a".repeat(512), 1),
        item("unrelated", 2),
      ]);
      const atLimit = yield* engine.search(corpus, {
        query: "a".repeat(256),
        scope: "all",
        currentCwd: "/a",
      });
      expect(atLimit.fuzzySkippedForLongQuery).toBe(false);
      expect(events.some((event) => event.phase === "fuzzy")).toBe(true);

      events.length = 0;
      const overLimit = yield* engine.search(corpus, {
        query: "a".repeat(257),
        scope: "all",
        currentCwd: "/a",
      });
      expect(overLimit.fuzzySkippedForLongQuery).toBe(true);
      expect(events.some((event) => event.phase === "fuzzy")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "counts each matching raw message once across overlapping segments",
    () => {
      const repeated = `${"needle ".repeat(18_000)}`;
      const otherItems = Array.from({ length: 199 }, (_, index) =>
        item(`needle item ${index}`, index + 2),
      );
      return providedRun([item(repeated, 1), ...otherItems], "needle").pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            expect(outcome.results).toHaveLength(200);
            expect(outcome.hasMoreResults).toBe(false);
            expect(
              outcome.results.filter((result) => result.item.text === repeated),
            ).toHaveLength(1);
          }),
        ),
      );
    },
  );

  it.effect(
    "observes normalization and segmentation as preparation work",
    () => {
      const events: Array<HistorySearchBatchEvent> = [];
      return Effect.gen(function* () {
        const engine = yield* HistorySearchEngine;
        yield* engine.prepare([item("a ".repeat(20_000), 1)]);

        const recordPreparation = events.filter(
          (event) => event.phase === "prepare-record",
        );
        expect(recordPreparation).toHaveLength(1);
        expect(recordPreparation[0]).toMatchObject({
          phase: "prepare-record",
          size: 1,
        });
        expect(recordPreparation[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
      }).pipe(
        Effect.provide(
          makeHistorySearchEngineLayer((event) => events.push(event)),
        ),
      );
    },
  );

  it.effect(
    "keeps preparation and both search lanes within deterministic bounds",
    () => {
      const events: Array<HistorySearchBatchEvent> = [];
      const items = [
        ...Array.from({ length: 2_048 }, (_, index) =>
          item(`deploy blue widget ${index}`, index),
        ),
        item(`${"x".repeat(60_000)} needle ${"y".repeat(60_000)}`, 3_000),
      ];

      return run(items, "blue widget").pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(
              events.some((event) => event.phase === "prepare-fuzzy"),
            ).toBe(true);
            expect(events.some((event) => event.phase === "direct")).toBe(true);
            expect(events.some((event) => event.phase === "fuzzy")).toBe(true);
            for (const event of events) {
              expect(event.size).toBeGreaterThan(0);
              expect(event.size).toBeLessThanOrEqual(
                HISTORY_SEARCH_LIMITS.batchSize,
              );
              if (event.maximumTargetCodeUnits !== undefined) {
                expect(event.maximumTargetCodeUnits).toBeLessThanOrEqual(
                  HISTORY_SEARCH_LIMITS.segmentCodeUnits,
                );
              }
              if (event.maximumQueryCodeUnits !== undefined) {
                expect(event.maximumQueryCodeUnits).toBeLessThanOrEqual(
                  HISTORY_SEARCH_LIMITS.fuzzyQueryCodeUnits,
                );
              }
              expect(Number.isFinite(event.elapsedMs)).toBe(true);
              expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
            }
          }),
        ),
        Effect.provide(
          makeHistorySearchEngineLayer((event) => events.push(event)),
        ),
      );
    },
  );
});
