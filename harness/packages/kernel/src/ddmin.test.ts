import { describe, expect, it } from "vitest";

import { deltaDebug, type DeltaDebugTestOutcome } from "./ddmin.js";

describe("deltaDebug", () => {
  it("confirms a passing full set in one run set", async () => {
    const tested: string[][] = [];

    const result = await deltaDebug({
      items: ["classify", "lookup", "answer"],
      test: async (subset) => {
        tested.push([...subset]);
        return "pass";
      },
      budget: { maxRunSets: 20 },
    });

    expect(result).toMatchObject({
      culprits: [],
      verdict: "isolated",
      runSetsUsed: 1,
    });
    expect(tested).toEqual([["classify", "lookup", "answer"]]);
    expect(result.log).toEqual([
      {
        runSet: 1,
        subset: ["classify", "lookup", "answer"],
        outcome: "pass",
      },
    ]);
  });

  it("isolates two items that fail only in combination across halves", async () => {
    const result = await deltaDebug({
      items: ["classify", "retrieve", "lookup", "answer"],
      test: oracle((subset) =>
        ["classify", "lookup"].every((item) => subset.has(item)),
      ),
      budget: { maxRunSets: 20 },
    });

    expect(result.verdict).toBe("isolated");
    expect(result.culprits).toEqual([["classify", "lookup"]]);
    expect(result.log[0]).toMatchObject({
      subset: ["classify", "retrieve", "lookup", "answer"],
      outcome: "fail",
    });
  });

  it("reports the full set when every proper subset passes", async () => {
    const result = await deltaDebug({
      items: ["a", "b", "c"],
      test: oracle((subset) => subset.size === 3),
      budget: { maxRunSets: 10 },
    });

    expect(result.verdict).toBe("isolated");
    expect(result.culprits).toEqual([["a", "b", "c"]]);
  });

  it("finds every independent and overlapping minimal failure", async () => {
    const failures = [
      ["a", "c"],
      ["b", "d"],
      ["c", "e"],
    ] as const;
    const result = await deltaDebug({
      items: ["a", "b", "c", "d", "e"],
      test: oracle((subset) =>
        failures.some((failure) => failure.every((item) => subset.has(item))),
      ),
      budget: { maxRunSets: 40 },
    });

    expect(result.verdict).toBe("isolated");
    expect(result.culprits).toEqual([
      ["a", "c"],
      ["b", "d"],
      ["c", "e"],
    ]);
  });

  it("isolates a minimal failure when intermediate supersets pass", async () => {
    const items = ["a", "b", "c", "d"];
    const result = await deltaDebug({
      items,
      test: oracle(
        (subset) =>
          sameMembers(subset, new Set(["a", "c"])) ||
          sameMembers(subset, new Set(items)),
      ),
      budget: { maxRunSets: 20 },
    });

    expect(result.verdict).toBe("isolated");
    expect(result.culprits).toEqual([["a", "c"]]);
  });

  it("returns inconclusive without a guess when its run-set budget ends", async () => {
    const result = await deltaDebug({
      items: ["a", "b", "c"],
      test: oracle((subset) => subset.has("a")),
      budget: { maxRunSets: 1 },
    });

    expect(result).toMatchObject({
      culprits: [],
      verdict: "inconclusive",
      runSetsUsed: 1,
    });
    expect(result.log).toHaveLength(1);
  });

  it("returns inconclusive for an ambiguous oracle outcome", async () => {
    const result = await deltaDebug({
      items: ["a"],
      test: async () => "ambiguous",
      budget: { maxRunSets: 2 },
    });

    expect(result).toEqual({
      culprits: [],
      verdict: "inconclusive",
      runSetsUsed: 1,
      log: [{ runSet: 1, subset: ["a"], outcome: "ambiguous" }],
    });
  });

  it("returns inconclusive when the empty set itself fails", async () => {
    const result = await deltaDebug({
      items: ["a", "b"],
      test: async () => "fail",
      budget: { maxRunSets: 10 },
    });

    expect(result.verdict).toBe("inconclusive");
    expect(result.culprits).toEqual([]);
    expect(result.log.at(-1)).toMatchObject({ subset: [], outcome: "fail" });
  });

  it("is deterministic for deterministic outcomes", async () => {
    const run = () =>
      deltaDebug({
        items: ["a", "b", "c", "d"],
        test: oracle(
          (subset) => subset.has("a") || (subset.has("b") && subset.has("d")),
        ),
        budget: { maxRunSets: 20 },
      });

    expect(await run()).toEqual(await run());
  });

  it("finds only ground-truth minimal failures across 50 seeds", async () => {
    const groundTruthSignatures = new Set<string>();
    for (let seed = 0; seed < 50; seed += 1) {
      for (const scenario of scenarios(seed)) {
        groundTruthSignatures.add(JSON.stringify(scenario.minima));
        const result = await deltaDebug({
          items: scenario.items,
          test: oracle(scenario.fails),
          budget: { maxRunSets: 200 },
        });

        expect(result.runSetsUsed).toBe(result.log.length);
        assertNoWrongPositive(result.culprits, scenario.fails);
        if (result.verdict === "isolated") {
          expect(result.culprits).toEqual(scenario.minima);
        }
      }
    }
    expect(groundTruthSignatures.size).toBeGreaterThan(50);
  });

  it("rejects items without distinct identities", async () => {
    await expect(
      deltaDebug({
        items: ["a", "a"],
        test: oracle((subset) => subset.has("a")),
        budget: { maxRunSets: 10 },
      }),
    ).rejects.toThrow("items must be unique");
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid maxRunSets value: %s",
    async (maxRunSets) => {
      await expect(
        deltaDebug({
          items: ["a"],
          test: async () => "pass",
          budget: { maxRunSets },
        }),
      ).rejects.toThrow(/maxRunSets/);
    },
  );
});

interface Scenario {
  readonly items: readonly string[];
  readonly minima: readonly (readonly string[])[];
  readonly fails: (subset: ReadonlySet<string>) => boolean;
}

function scenarios(seed: number): Scenario[] {
  const items = ["a", "b", "c", "d", "e", "f", "g"];
  const random = seededRandom(seed + 1);
  const choices = shuffled(items, random);
  const single = [choices[0]!] as const;
  const pair = [choices[1]!, choices[2]!] as const;
  const independent = [
    [choices[0]!, choices[1]!],
    [choices[2]!, choices[3]!],
    [choices[4]!, choices[5]!],
  ] as const;
  const monotone = [
    [choices[0]!, choices[2]!],
    [choices[1]!, choices[3]!, choices[5]!],
  ] as const;
  const nonMonotone = choices.slice(0, 1 + Math.floor(random() * 4));

  return [
    scenario(items, [single], (subset) => containsAll(subset, single)),
    scenario(items, [pair], (subset) => containsAll(subset, pair)),
    scenario(items, independent, (subset) =>
      independent.some((failure) => containsAll(subset, failure)),
    ),
    scenario(items, monotone, (subset) =>
      monotone.some((failure) => containsAll(subset, failure)),
    ),
    scenario(
      items,
      [nonMonotone],
      (subset) =>
        sameMembers(subset, new Set(nonMonotone)) ||
        sameMembers(subset, new Set(items)),
    ),
  ];
}

function scenario(
  items: readonly string[],
  minima: readonly (readonly string[])[],
  fails: (subset: ReadonlySet<string>) => boolean,
): Scenario {
  return {
    items,
    minima: [...minima]
      .map((failure) => items.filter((item) => failure.includes(item)))
      .sort(
        (left, right) =>
          left.length - right.length || compareByItemOrder(left, right, items),
      ),
    fails,
  };
}

function compareByItemOrder(
  left: readonly string[],
  right: readonly string[],
  items: readonly string[],
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference =
      items.indexOf(left[index]!) - items.indexOf(right[index]!);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function assertNoWrongPositive(
  culprits: readonly (readonly string[])[],
  fails: (subset: ReadonlySet<string>) => boolean,
): void {
  for (const [index, culprit] of culprits.entries()) {
    expect(fails(new Set(culprit))).toBe(true);
    for (const properSubset of allProperSubsets(culprit)) {
      expect(fails(new Set(properSubset))).toBe(false);
    }
    for (const other of culprits.slice(index + 1)) {
      expect(containsAll(new Set(other), culprit)).toBe(false);
      expect(containsAll(new Set(culprit), other)).toBe(false);
    }
  }
}

function allProperSubsets(items: readonly string[]): string[][] {
  const subsets: string[][] = [];
  for (let mask = 0; mask < 2 ** items.length - 1; mask += 1) {
    subsets.push(items.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
}

function oracle(
  fails: (subset: ReadonlySet<string>) => boolean,
): (subset: readonly string[]) => Promise<DeltaDebugTestOutcome> {
  return async (subset) => (fails(new Set(subset)) ? "fail" : "pass");
}

function containsAll(
  subset: ReadonlySet<string>,
  members: readonly string[],
): boolean {
  return members.every((member) => subset.has(member));
}

function sameMembers(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffled<Item>(items: readonly Item[], random: () => number): Item[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}
