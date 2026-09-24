import { MIN_DISTINCT_STEPS } from "@rightmodeler/kernel";

export interface BindingCase {
  readonly caseId: string;
  readonly split: "shortlist" | "holdout";
  readonly traceId: string | undefined;
  readonly stepIndex: number;
}

export interface BindingSite {
  readonly stepId: string;
  readonly traceKey?: string;
  readonly replayable: boolean;
}

export interface FamilyBinding {
  readonly kind: "trace_key" | "trace_match";
  readonly stepIds: readonly string[];
  readonly caseSteps: ReadonlyMap<string, string>;
  readonly holdoutCases: number;
  readonly leftOut: {
    readonly ambiguous: number;
    readonly unmatched: number;
    readonly unreplayable: number;
  };
  readonly requiredDistinctSteps: number;
}

export function traceStepKey(traceId: string, stepIndex: number): string {
  return `${traceId}\0${stepIndex}`;
}

const SPLITS = ["shortlist", "holdout"] as const;

function boundStepIds(
  bindingCase: BindingCase,
  bindings: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined {
  return bindingCase.traceId === undefined
    ? undefined
    : bindings.get(traceStepKey(bindingCase.traceId, bindingCase.stepIndex));
}

function placedHoldoutCases(
  cases: readonly BindingCase[],
  caseSteps: ReadonlyMap<string, string>,
): number {
  return cases.filter(
    ({ caseId, split }) => split === "holdout" && caseSteps.has(caseId),
  ).length;
}

export function bindFamily(input: {
  readonly family: string;
  readonly cases: readonly BindingCase[];
  readonly sites: readonly BindingSite[];
  readonly sharedStepIds: ReadonlySet<string>;
  readonly bindings: ReadonlyMap<string, readonly string[]>;
}): FamilyBinding {
  const keyed = input.sites.filter(({ traceKey }) => traceKey === input.family);
  const caseSteps = new Map<string, string>();

  if (keyed.length === 0) {
    const leftOut = { ambiguous: 0, unmatched: 0, unreplayable: 0 };
    for (const bindingCase of input.cases) {
      const bound = boundStepIds(bindingCase, input.bindings) ?? [];
      if (bound.length === 0) {
        leftOut.unmatched += 1;
        continue;
      }
      const site = input.sites.find(({ stepId }) => stepId === bound[0]);
      if (
        bound.length > 1 ||
        site?.traceKey !== undefined ||
        input.sharedStepIds.has(bound[0]!)
      ) {
        leftOut.ambiguous += 1;
      } else if (site?.replayable) {
        caseSteps.set(bindingCase.caseId, bound[0]!);
      } else {
        leftOut.unreplayable += 1;
      }
    }
    const used = new Set(caseSteps.values());
    return {
      kind: "trace_match",
      stepIds: input.sites
        .map(({ stepId }) => stepId)
        .filter((stepId) => used.has(stepId)),
      caseSteps,
      holdoutCases: placedHoldoutCases(input.cases, caseSteps),
      leftOut,
      requiredDistinctSteps: MIN_DISTINCT_STEPS,
    };
  }

  const keyedStepIds = new Set(keyed.map(({ stepId }) => stepId));
  const replayable = keyed
    .filter((site) => site.replayable)
    .map(({ stepId }) => stepId);
  let unreplayableCases = 0;
  for (const split of SPLITS) {
    let next = 0;
    for (const bindingCase of input.cases.filter(
      (candidate) => candidate.split === split,
    )) {
      const bound = boundStepIds(bindingCase, input.bindings);
      const onlySite =
        bound?.length === 1 && keyedStepIds.has(bound[0]!)
          ? bound[0]!
          : undefined;
      if (onlySite !== undefined) {
        if (replayable.includes(onlySite)) {
          caseSteps.set(bindingCase.caseId, onlySite);
        } else {
          unreplayableCases += 1;
        }
      } else if (replayable.length > 0) {
        caseSteps.set(
          bindingCase.caseId,
          replayable[next % replayable.length]!,
        );
        next += 1;
      } else {
        unreplayableCases += 1;
      }
    }
  }

  const used = new Set(caseSteps.values());
  const stepIds = replayable.filter((stepId) => used.has(stepId));
  return {
    kind: "trace_key",
    stepIds,
    caseSteps,
    holdoutCases: placedHoldoutCases(input.cases, caseSteps),
    leftOut: { ambiguous: 0, unmatched: 0, unreplayable: unreplayableCases },
    requiredDistinctSteps: Math.min(MIN_DISTINCT_STEPS, stepIds.length),
  };
}
