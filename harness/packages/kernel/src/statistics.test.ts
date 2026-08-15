import { describe, expect, it } from "vitest";

import {
  MIN_DISTINCT_STEPS,
  MIN_DISTINCT_TRAJECTORIES,
  MIN_REVIEW_TRIALS,
  clusterBootstrap,
  wilson,
} from "./statistics.js";

describe("statistical minimums", () => {
  it("names each minimum by its unit", () => {
    expect(MIN_REVIEW_TRIALS).toBe(10);
    expect(MIN_DISTINCT_STEPS).toBe(2);
    expect(MIN_DISTINCT_TRAJECTORIES).toBe(5);
  });
});

describe("wilson", () => {
  // Expected values were independently derived from the NIST/SEMATECH
  // e-Handbook Wilson score formula using adjusted standard-normal quantiles.
  const knownValues = [
    {
      passes: 0,
      n: 1,
      confidence: 0.95,
      comparisons: 1,
      lower: 0,
      upper: 0.7934506856227624,
    },
    {
      passes: 1,
      n: 1,
      confidence: 0.95,
      comparisons: 1,
      lower: 0.2065493143772375,
      upper: 1,
    },
    {
      passes: 5,
      n: 10,
      confidence: 0.95,
      comparisons: 1,
      lower: 0.23659309051256405,
      upper: 0.763406909487436,
    },
    {
      passes: 50,
      n: 100,
      confidence: 0.95,
      comparisons: 1,
      lower: 0.4038315303659957,
      upper: 0.5961684696340044,
    },
    {
      passes: 95,
      n: 100,
      confidence: 0.95,
      comparisons: 1,
      lower: 0.8882495307680808,
      upper: 0.9784563208456319,
    },
    {
      passes: 5,
      n: 10,
      confidence: 0.95,
      comparisons: 4,
      lower: 0.1900883952886176,
      upper: 0.8099116047113823,
    },
    {
      passes: 8,
      n: 10,
      confidence: 0.9,
      comparisons: 2,
      lower: 0.4901624715366419,
      upper: 0.9433178485456246,
    },
    {
      passes: 0,
      n: 10,
      confidence: 0.99,
      comparisons: 3,
      lower: 0,
      upper: 0.462810243634795,
    },
  ] as const;

  it.each(knownValues)(
    "matches the known interval for $passes/$n at $confidence confidence and $comparisons comparison(s)",
    ({ passes, n, confidence, comparisons, lower, upper }) => {
      const interval = wilson(passes, n, { confidence, comparisons });

      expect(interval.point).toBe(passes / n);
      expect(interval.lower).toBeCloseTo(lower, 8);
      expect(interval.upper).toBeCloseTo(upper, 8);
    },
  );

  it("represents an empty sample as wholly uncertain", () => {
    expect(wilson(0, 0)).toEqual({ point: 0, lower: 0, upper: 1 });
  });

  it("keeps every interval and point inside [0, 1] with point contained", () => {
    const violations: string[] = [];
    for (const confidence of [0.8, 0.9, 0.95, 0.99]) {
      for (const comparisons of [1, 2, 8]) {
        for (let n = 1; n <= 100; n += 1) {
          for (let passes = 0; passes <= n; passes += 1) {
            const interval = wilson(passes, n, {
              confidence,
              comparisons,
            });

            if (
              !(interval.lower >= 0) ||
              !(interval.upper <= 1) ||
              !(interval.lower <= interval.point) ||
              !(interval.point <= interval.upper)
            ) {
              violations.push(
                `confidence=${confidence} comparisons=${comparisons} ${passes}/${n}: ${JSON.stringify(interval)}`,
              );
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("moves both bounds monotonically as passes increase", () => {
    for (let n = 1; n <= 200; n += 1) {
      let previous = wilson(0, n);
      for (let passes = 1; passes <= n; passes += 1) {
        const current = wilson(passes, n);

        expect(current.point).toBeGreaterThan(previous.point);
        expect(current.lower).toBeGreaterThanOrEqual(previous.lower);
        expect(current.upper).toBeGreaterThanOrEqual(previous.upper);
        previous = current;
      }
    }
  });

  it("widens monotonically as the Bonferroni comparison count grows", () => {
    for (let n = 1; n <= 100; n += 1) {
      for (let passes = 0; passes <= n; passes += 1) {
        let previous = wilson(passes, n, { comparisons: 1 });
        for (const comparisons of [2, 4, 16]) {
          const current = wilson(passes, n, { comparisons });

          expect(current.point).toBe(previous.point);
          expect(current.lower).toBeLessThanOrEqual(previous.lower);
          expect(current.upper).toBeGreaterThanOrEqual(previous.upper);
          previous = current;
        }
      }
    }
  });

  it.each([
    [-1, 1, {}],
    [2, 1, {}],
    [0.5, 1, {}],
    [0, -1, {}],
    [0, 1.5, {}],
    [0, 1, { confidence: 0 }],
    [0, 1, { confidence: 1 }],
    [0, 1, { comparisons: 0 }],
    [0, 1, { comparisons: 1.5 }],
  ] as const)("rejects invalid inputs %#", (passes, n, options) => {
    expect(() => wilson(passes, n, options)).toThrow();
  });
});

describe("clusterBootstrap", () => {
  const clusteredExecutions = {
    alpha: [true, true, false, true],
    beta: [false, false],
    gamma: [true],
    delta: [true, false, true],
  } as const;

  it("is deterministic for a seed and independent of record insertion order", () => {
    const options = { resamples: 2_000, seed: 7321 };
    const reordered = {
      gamma: clusteredExecutions.gamma,
      alpha: clusteredExecutions.alpha,
      delta: clusteredExecutions.delta,
      beta: clusteredExecutions.beta,
    };

    expect(clusterBootstrap(clusteredExecutions, options)).toEqual(
      clusterBootstrap(clusteredExecutions, options),
    );
    expect(clusterBootstrap(reordered, options)).toEqual(
      clusterBootstrap(clusteredExecutions, options),
    );
  });

  it("reports bounded percentile intervals containing the observed point", () => {
    const interval = clusterBootstrap(clusteredExecutions, {
      resamples: 2_000,
      seed: 42,
    });

    expect(interval.point).toBe(0.6);
    expect(interval.lower).toBeGreaterThanOrEqual(0);
    expect(interval.upper).toBeLessThanOrEqual(1);
    expect(interval.lower).toBeLessThanOrEqual(interval.point);
    expect(interval.point).toBeLessThanOrEqual(interval.upper);
  });

  it("resamples whole trajectories rather than individual executions", () => {
    const interval = clusterBootstrap(
      {
        passTrajectory: Array.from({ length: 100 }, () => true),
        failTrajectory: Array.from({ length: 100 }, () => false),
      },
      { resamples: 500, seed: 17 },
    );

    expect(interval).toEqual({
      point: 0.5,
      lower: 0,
      upper: 1,
      method: "percentile",
    });
  });

  it("weights the observed point by executions while sampling trajectories", () => {
    const interval = clusterBootstrap(
      {
        long: [true, true, true, true, true, true, true, true, true],
        short: [false],
      },
      { resamples: 500, seed: 23 },
    );

    expect(interval.point).toBe(0.9);
    expect(interval.lower).toBe(0);
    expect(interval.upper).toBe(1);
  });

  it("retains finite-sample uncertainty when every clustered execution passes", () => {
    const outcomes = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `trajectory-${index}`,
        [true, true],
      ]),
    );

    const interval = clusterBootstrap(outcomes, { resamples: 500, seed: 9 });
    expect(interval.lower).toBeCloseTo(wilson(5, 5).lower, 12);
    expect(interval.method).toBe("finite_sample_envelope");
    expect(
      clusterBootstrap(outcomes, {
        resamples: 500,
        seed: 9,
        comparisons: 100,
      }).lower,
    ).toBeLessThan(0.5);
  });

  it("reports when the trajectory percentile interval binds", () => {
    const outcomes = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `trajectory-${index}`,
        index < 5 ? [true, true] : [false, false],
      ]),
    );
    const interval = clusterBootstrap(outcomes, {
      resamples: 2_000,
      seed: 17,
    });

    expect(interval.point).toBe(0.625);
    expect(interval.method).toBe("percentile");
    expect(interval.lower).not.toBeCloseTo(wilson(10, 16).lower, 4);
  });

  it("uses trajectory count, not execution count, for finite-sample uncertainty", () => {
    const oneExecutionEach = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`trajectory-${index}`, [true]]),
    );
    const oneHundredExecutionsEach = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `trajectory-${index}`,
        Array.from({ length: 100 }, () => true),
      ]),
    );

    expect(
      clusterBootstrap(oneHundredExecutionsEach, {
        resamples: 500,
        seed: 19,
      }),
    ).toEqual(clusterBootstrap(oneExecutionEach, { resamples: 500, seed: 19 }));
  });

  it.each([
    [{}, { resamples: 100, seed: 1 }],
    [{ empty: [] }, { resamples: 100, seed: 1 }],
    [{ valid: [true] }, { resamples: 0, seed: 1 }],
    [{ valid: [true] }, { resamples: 1.5, seed: 1 }],
    [{ valid: [true] }, { resamples: 100, seed: 1.5 }],
  ] as const)("rejects invalid bootstrap input %#", (executions, options) => {
    expect(() => clusterBootstrap(executions, options)).toThrow();
  });
});
