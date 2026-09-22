import { describe, expect, it } from "vitest";

import {
  bindFamily,
  traceStepKey,
  type BindingCase,
  type BindingSite,
} from "./family-binding.js";

function cases(
  split: BindingCase["split"],
  count: number,
  traceId?: (index: number) => string,
): BindingCase[] {
  return Array.from({ length: count }, (_, index) => ({
    caseId: `${split}-${index}`,
    split,
    traceId: traceId?.(index),
    stepIndex: 0,
  }));
}

function bindings(
  entries: ReadonlyArray<readonly [string, readonly string[]]>,
): ReadonlyMap<string, readonly string[]> {
  return new Map(
    entries.map(([traceId, stepIds]) => [traceStepKey(traceId, 0), stepIds]),
  );
}

const unkeyed: BindingSite[] = [
  { stepId: "a", replayable: true },
  { stepId: "b", replayable: true },
];

describe("bindFamily", () => {
  it("passes an unkeyed family through in path order", () => {
    const familyCases = [...cases("shortlist", 3), ...cases("holdout", 3)];

    const binding = bindFamily({
      family: "summarize",
      cases: familyCases,
      sites: unkeyed,
      pathOrder: ["b", "a"],
      bindings: new Map(),
    });

    expect(binding).toMatchObject({
      kind: "path_order",
      stepIds: ["b", "a"],
      holdoutCases: 3,
      unreplayableCases: 0,
      requiredDistinctSteps: 2,
    });
    expect([...binding.caseSteps]).toEqual([
      ["shortlist-0", "b"],
      ["shortlist-1", "a"],
      ["shortlist-2", "b"],
      ["holdout-0", "b"],
      ["holdout-1", "a"],
      ["holdout-2", "b"],
    ]);
  });

  it("places a uniquely bound case on its own call site", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: cases("shortlist", 4, (index) => `trace-${index}`),
      sites: [
        { stepId: "text", traceKey: "summarize", replayable: true },
        { stepId: "stream", traceKey: "summarize", replayable: true },
      ],
      pathOrder: [],
      bindings: bindings([
        ["trace-0", ["stream"]],
        ["trace-1", ["stream"]],
        ["trace-2", ["stream"]],
        ["trace-3", ["text"]],
      ]),
    });

    expect(binding.kind).toBe("trace_key");
    expect([...binding.caseSteps]).toEqual([
      ["shortlist-0", "stream"],
      ["shortlist-1", "stream"],
      ["shortlist-2", "stream"],
      ["shortlist-3", "text"],
    ]);
    expect(binding.stepIds).toEqual(["text", "stream"]);
  });

  it("leaves out a case bound to a call site that needs tools", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: cases("holdout", 2, (index) => `trace-${index}`),
      sites: [
        { stepId: "text", traceKey: "summarize", replayable: true },
        { stepId: "agent", traceKey: "summarize", replayable: false },
      ],
      pathOrder: [],
      bindings: bindings([
        ["trace-0", ["agent"]],
        ["trace-1", ["text"]],
      ]),
    });

    expect(binding.unreplayableCases).toBe(1);
    expect(binding.caseSteps.has("holdout-0")).toBe(false);
    expect([...binding.caseSteps]).toEqual([["holdout-1", "text"]]);
    expect(binding.holdoutCases).toBe(1);
  });

  it("round-robins cases the trace could not tell apart over the replayable keyed sites only", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: [
        ...cases("shortlist", 3, (index) => `trace-${index}`),
        ...cases("holdout", 1),
      ],
      sites: [
        { stepId: "other", replayable: true },
        { stepId: "text", traceKey: "summarize", replayable: true },
        { stepId: "agent", traceKey: "summarize", replayable: false },
        { stepId: "stream", traceKey: "summarize", replayable: true },
      ],
      pathOrder: ["other"],
      bindings: bindings([
        ["trace-0", ["agent", "stream", "text"]],
        ["trace-1", ["agent", "stream", "text"]],
        ["trace-2", ["agent", "stream", "text"]],
      ]),
    });

    expect([...binding.caseSteps]).toEqual([
      ["shortlist-0", "text"],
      ["shortlist-1", "stream"],
      ["shortlist-2", "text"],
      ["holdout-0", "text"],
    ]);
    expect(binding.unreplayableCases).toBe(0);
  });

  it("drops a keyed call site that received no case", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: cases("shortlist", 2, (index) => `trace-${index}`),
      sites: [
        { stepId: "text", traceKey: "summarize", replayable: true },
        { stepId: "stream", traceKey: "summarize", replayable: true },
      ],
      pathOrder: [],
      bindings: bindings([
        ["trace-0", ["text"]],
        ["trace-1", ["text"]],
      ]),
    });

    expect(binding.stepIds).toEqual(["text"]);
  });

  it("requires min(2, bound sites) distinct steps", () => {
    const three: BindingSite[] = ["a", "b", "c"].map((stepId) => ({
      stepId,
      traceKey: "summarize",
      replayable: true,
    }));

    expect(
      bindFamily({
        family: "summarize",
        cases: cases("shortlist", 3),
        sites: three.slice(0, 1),
        pathOrder: [],
        bindings: new Map(),
      }).requiredDistinctSteps,
    ).toBe(1);
    expect(
      bindFamily({
        family: "summarize",
        cases: cases("shortlist", 3),
        sites: three,
        pathOrder: [],
        bindings: new Map(),
      }).requiredDistinctSteps,
    ).toBe(2);
  });
});
