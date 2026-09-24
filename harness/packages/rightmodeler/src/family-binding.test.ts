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
  it("places each case of an unkeyed family on the call site its trace matched", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: [
        ...cases("shortlist", 3, (index) => `trace-${index}`),
        ...cases("holdout", 2, (index) => `trace-${index + 3}`),
      ],
      sites: unkeyed,
      sharedStepIds: new Set(),
      bindings: bindings([
        ["trace-0", ["b"]],
        ["trace-1", ["b"]],
        ["trace-2", ["a"]],
        ["trace-3", ["a"]],
        ["trace-4", ["a"]],
      ]),
    });

    expect(binding).toMatchObject({
      kind: "trace_match",
      stepIds: ["a", "b"],
      holdoutCases: 2,
      leftOut: { ambiguous: 0, unmatched: 0, unreplayable: 0 },
    });
    expect([...binding.caseSteps]).toEqual([
      ["shortlist-0", "b"],
      ["shortlist-1", "b"],
      ["shortlist-2", "a"],
      ["holdout-0", "a"],
      ["holdout-1", "a"],
    ]);
  });

  it("leaves out cases matched to several call sites as ambiguous", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: cases("holdout", 2, (index) => `trace-${index}`),
      sites: unkeyed,
      sharedStepIds: new Set(),
      bindings: bindings([
        ["trace-0", ["a", "b"]],
        ["trace-1", ["b"]],
      ]),
    });

    expect([...binding.caseSteps]).toEqual([["holdout-1", "b"]]);
    expect(binding.leftOut).toEqual({
      ambiguous: 1,
      unmatched: 0,
      unreplayable: 0,
    });
    expect(binding.stepIds).toEqual(["b"]);
    expect(binding.holdoutCases).toBe(1);
  });

  it("leaves out cases with no recorded match as unmatched", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: [
        ...cases("shortlist", 3, (index) => `trace-${index}`),
        ...cases("holdout", 1),
      ],
      sites: unkeyed,
      sharedStepIds: new Set(),
      bindings: bindings([
        ["trace-0", []],
        ["trace-2", ["a"]],
      ]),
    });

    expect([...binding.caseSteps]).toEqual([["shortlist-2", "a"]]);
    expect(binding.leftOut).toEqual({
      ambiguous: 0,
      unmatched: 3,
      unreplayable: 0,
    });
  });

  it("never places an unkeyed family on another family's keyed call site", () => {
    const binding = bindFamily({
      family: "support",
      cases: cases("shortlist", 2, (index) => `trace-${index}`),
      sites: [
        { stepId: "text", traceKey: "summarize", replayable: true },
        ...unkeyed,
      ],
      sharedStepIds: new Set(),
      bindings: bindings([
        ["trace-0", ["text"]],
        ["trace-1", ["a"]],
      ]),
    });

    expect(binding.kind).toBe("trace_match");
    expect([...binding.caseSteps]).toEqual([["shortlist-1", "a"]]);
    expect(binding.leftOut.ambiguous).toBe(1);
  });

  it("never places a case on a call site that another family's traces also matched", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: cases("shortlist", 2, (index) => `trace-${index}`),
      sites: unkeyed,
      sharedStepIds: new Set(["a"]),
      bindings: bindings([
        ["trace-0", ["a"]],
        ["trace-1", ["b"]],
      ]),
    });

    expect([...binding.caseSteps]).toEqual([["shortlist-1", "b"]]);
    expect(binding.stepIds).toEqual(["b"]);
    expect(binding.leftOut.ambiguous).toBe(1);
  });

  it("leaves out cases from a call site replay cannot run", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: cases("holdout", 2, (index) => `trace-${index}`),
      sites: [...unkeyed, { stepId: "agent", replayable: false }],
      sharedStepIds: new Set(),
      bindings: bindings([
        ["trace-0", ["agent"]],
        ["trace-1", ["a"]],
      ]),
    });

    expect([...binding.caseSteps]).toEqual([["holdout-1", "a"]]);
    expect(binding.leftOut).toEqual({
      ambiguous: 0,
      unmatched: 0,
      unreplayable: 1,
    });
    expect(binding.holdoutCases).toBe(1);
  });

  it("keeps the unbound distinct-step floor at two", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: cases("shortlist", 2, (index) => `trace-${index}`),
      sites: unkeyed,
      sharedStepIds: new Set(),
      bindings: bindings([
        ["trace-0", ["a"]],
        ["trace-1", ["a"]],
      ]),
    });

    expect(binding.stepIds).toEqual(["a"]);
    expect(binding.requiredDistinctSteps).toBe(2);
  });

  it("places a uniquely bound case on its own call site", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: cases("shortlist", 4, (index) => `trace-${index}`),
      sites: [
        { stepId: "text", traceKey: "summarize", replayable: true },
        { stepId: "stream", traceKey: "summarize", replayable: true },
      ],
      sharedStepIds: new Set(),
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
      sharedStepIds: new Set(),
      bindings: bindings([
        ["trace-0", ["agent"]],
        ["trace-1", ["text"]],
      ]),
    });

    expect(binding.leftOut.unreplayable).toBe(1);
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
      sharedStepIds: new Set(),
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
    expect(binding.leftOut.unreplayable).toBe(0);
  });

  it("drops a keyed call site that received no case", () => {
    const binding = bindFamily({
      family: "summarize",
      cases: cases("shortlist", 2, (index) => `trace-${index}`),
      sites: [
        { stepId: "text", traceKey: "summarize", replayable: true },
        { stepId: "stream", traceKey: "summarize", replayable: true },
      ],
      sharedStepIds: new Set(),
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
        sharedStepIds: new Set(),
        bindings: new Map(),
      }).requiredDistinctSteps,
    ).toBe(1);
    expect(
      bindFamily({
        family: "summarize",
        cases: cases("shortlist", 3),
        sites: three,
        sharedStepIds: new Set(),
        bindings: new Map(),
      }).requiredDistinctSteps,
    ).toBe(2);
  });
});
