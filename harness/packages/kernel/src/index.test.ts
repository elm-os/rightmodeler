import { describe, expect, it } from "vitest";

import {
  MIN_REVIEW_TRIALS,
  ReleaseGatePolicy,
  aggregate,
  assignSplits,
  clusterBootstrap,
  evaluateGates,
  judgeExecution,
  pickJudge,
  selectWinner,
  wilson,
} from "./index.js";

describe("kernel public API", () => {
  it("exports every kernel capability", () => {
    expect(MIN_REVIEW_TRIALS).toBe(10);
    expect(ReleaseGatePolicy).toBeTypeOf("function");
    expect(aggregate).toBeTypeOf("function");
    expect(assignSplits).toBeTypeOf("function");
    expect(clusterBootstrap).toBeTypeOf("function");
    expect(evaluateGates).toBeTypeOf("function");
    expect(judgeExecution).toBeTypeOf("function");
    expect(pickJudge).toBeTypeOf("function");
    expect(selectWinner).toBeTypeOf("function");
    expect(wilson).toBeTypeOf("function");
  });
});
