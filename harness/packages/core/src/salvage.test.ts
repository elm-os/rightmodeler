import { describe, expect, it } from "vitest";

import { parseFacts, parseFactsStrict } from "./salvage.js";

const execution = {
  executionId: "execution-1",
  evidenceQuestionId: "question-1",
  caseId: "case-1",
  stepId: "step-1",
  candidateId: "candidate-1",
  trajectoryId: "trajectory-1",
  corpusSplit: "validation",
  selectionStage: "replay",
  terminalOutcome: "success",
  finalOutput: { answer: "done" },
  attribution: "ok",
};

const requestAttempt = {
  attemptId: "attempt-1",
  logicalCallId: "call-1",
  executionId: "execution-1",
  streamOutcome: "completed",
  usage: { inputTokens: 100, outputTokens: 25 },
  costUsd: 0.0025,
  costIsEstimate: false,
};

describe("fact salvage", () => {
  it("treats an empty input as an empty ledger", () => {
    expect(parseFacts("")).toEqual({ facts: [], droppedRows: 0 });
    expect(parseFactsStrict("")).toEqual([]);
  });

  it("keeps valid objects and lines while counting every malformed row", () => {
    const result = parseFacts([
      JSON.stringify(execution),
      requestAttempt,
      '{"executionId":',
      { ...requestAttempt, costUsd: "unknown" },
    ]);

    expect(result).toEqual({
      facts: [execution, requestAttempt],
      droppedRows: 2,
    });
  });

  it("parses JSONL without treating its trailing newline as a row", () => {
    const result = parseFacts(
      `${JSON.stringify(execution)}\n${JSON.stringify(requestAttempt)}\n`,
    );

    expect(result).toEqual({
      facts: [execution, requestAttempt],
      droppedRows: 0,
    });
  });

  it("counts blank rows inside JSONL as malformed", () => {
    const result = parseFacts(
      `${JSON.stringify(execution)}\n\n${JSON.stringify(requestAttempt)}`,
    );

    expect(result.droppedRows).toBe(1);
    expect(result.facts).toEqual([execution, requestAttempt]);
  });

  it("throws with the first malformed row in strict mode", () => {
    expect(() =>
      parseFactsStrict([
        execution,
        '{"attemptId":',
        { ...requestAttempt, costUsd: "unknown" },
      ]),
    ).toThrow(/^Invalid fact at row 2: Unexpected end of JSON input/);
  });

  it("returns all facts when strict input is valid", () => {
    expect(
      parseFactsStrict([execution, JSON.stringify(requestAttempt)]),
    ).toEqual([execution, requestAttempt]);
  });
});
