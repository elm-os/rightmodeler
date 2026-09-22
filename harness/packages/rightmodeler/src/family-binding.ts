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
  readonly kind: "trace_key" | "path_order";
  readonly stepIds: readonly string[];
  readonly caseSteps: ReadonlyMap<string, string>;
  readonly holdoutCases: number;
  readonly unreplayableCases: number;
  readonly requiredDistinctSteps: number;
}

export function traceStepKey(traceId: string, stepIndex: number): string {
  return `${traceId}\0${stepIndex}`;
}

const SPLITS = ["shortlist", "holdout"] as const;

export function bindFamily(input: {
  readonly family: string;
  readonly cases: readonly BindingCase[];
  readonly sites: readonly BindingSite[];
  readonly pathOrder: readonly string[];
  readonly bindings: ReadonlyMap<string, readonly string[]>;
}): FamilyBinding {
  const keyed = input.sites.filter(({ traceKey }) => traceKey === input.family);
  const caseSteps = new Map<string, string>();

  if (keyed.length === 0) {
    for (const split of SPLITS) {
      input.cases
        .filter((bindingCase) => bindingCase.split === split)
        .forEach((bindingCase, index) => {
          if (input.pathOrder.length === 0) return;
          caseSteps.set(
            bindingCase.caseId,
            input.pathOrder[index % input.pathOrder.length]!,
          );
        });
    }
    return {
      kind: "path_order",
      stepIds: input.pathOrder,
      caseSteps,
      holdoutCases: input.cases.filter(({ split }) => split === "holdout")
        .length,
      unreplayableCases: 0,
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
      const bound =
        bindingCase.traceId === undefined
          ? undefined
          : input.bindings.get(
              traceStepKey(bindingCase.traceId, bindingCase.stepIndex),
            );
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
    holdoutCases: input.cases.filter(
      ({ caseId, split }) => split === "holdout" && caseSteps.has(caseId),
    ).length,
    unreplayableCases,
    requiredDistinctSteps: Math.min(MIN_DISTINCT_STEPS, stepIds.length),
  };
}
