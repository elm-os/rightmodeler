export type DeltaDebugTestOutcome = "pass" | "fail";

export interface DeltaDebugBudget {
  readonly maxRunSets: number;
}

export interface DeltaDebugInput<Item> {
  readonly items: readonly Item[];
  readonly test: (subset: readonly Item[]) => Promise<DeltaDebugTestOutcome>;
  readonly budget: DeltaDebugBudget;
}

export interface DeltaDebugLogEntry<Item> {
  readonly runSet: number;
  readonly subset: readonly Item[];
  readonly outcome: DeltaDebugTestOutcome | "ambiguous";
}

export interface DeltaDebugResult<Item> {
  readonly culprits: readonly (readonly Item[])[];
  readonly verdict: "isolated" | "inconclusive";
  readonly runSetsUsed: number;
  readonly log: readonly DeltaDebugLogEntry<Item>[];
}

export async function deltaDebug<Item>(
  input: DeltaDebugInput<Item>,
): Promise<DeltaDebugResult<Item>> {
  if (
    !Number.isSafeInteger(input.budget.maxRunSets) ||
    input.budget.maxRunSets < 0
  ) {
    throw new RangeError("maxRunSets must be a non-negative safe integer");
  }
  if (new Set(input.items).size !== input.items.length) {
    throw new Error("items must be unique");
  }

  const log: DeltaDebugLogEntry<Item>[] = [];
  const culpritIndices: number[][] = [];
  let runSetsUsed = 0;

  const result = (
    verdict: DeltaDebugResult<Item>["verdict"],
  ): DeltaDebugResult<Item> => ({
    culprits: culpritIndices.map((indices) => pick(input.items, indices)),
    verdict,
    runSetsUsed,
    log,
  });

  const run = async (
    indices: readonly number[],
  ): Promise<DeltaDebugTestOutcome | "ambiguous" | "budget-exhausted"> => {
    if (runSetsUsed >= input.budget.maxRunSets) {
      return "budget-exhausted";
    }

    const subset = pick(input.items, indices);
    runSetsUsed += 1;
    const outcome: unknown = await input.test([...subset]);
    if (outcome !== "pass" && outcome !== "fail") {
      log.push({ runSet: runSetsUsed, subset, outcome: "ambiguous" });
      return "ambiguous";
    }

    log.push({ runSet: runSetsUsed, subset, outcome });
    return outcome;
  };

  const fullIndices = input.items.map((_, index) => index);
  const fullOutcome = await run(fullIndices);
  if (fullOutcome === "budget-exhausted" || fullOutcome === "ambiguous") {
    return result("inconclusive");
  }
  if (fullOutcome === "pass") {
    return result("isolated");
  }
  if (input.items.length === 0) {
    return result("inconclusive");
  }

  for (let size = 0; size < input.items.length; size += 1) {
    for (const indices of subsetsOfSize(input.items.length, size)) {
      if (culpritIndices.some((culprit) => contains(indices, culprit))) {
        continue;
      }

      const outcome = await run(indices);
      if (outcome === "budget-exhausted" || outcome === "ambiguous") {
        return result("inconclusive");
      }
      if (outcome === "fail") {
        if (indices.length === 0) {
          return result("inconclusive");
        }
        culpritIndices.push(indices);
      }
    }
  }

  if (culpritIndices.length === 0) {
    culpritIndices.push(fullIndices);
  }
  return result("isolated");
}

function pick<Item>(
  items: readonly Item[],
  indices: readonly number[],
): Item[] {
  return indices.map((index) => items[index]!);
}

function contains(
  candidate: readonly number[],
  subset: readonly number[],
): boolean {
  return subset.every((index) => candidate.includes(index));
}

function* subsetsOfSize(
  itemCount: number,
  size: number,
  start = 0,
  prefix: readonly number[] = [],
): Generator<number[]> {
  if (prefix.length === size) {
    yield [...prefix];
    return;
  }

  const remaining = size - prefix.length;
  for (let index = start; index <= itemCount - remaining; index += 1) {
    yield* subsetsOfSize(itemCount, size, index + 1, [...prefix, index]);
  }
}
