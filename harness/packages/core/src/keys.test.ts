import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FsStore } from "./store.js";
import {
  assertSafeSegment,
  budgetKey,
  budgetPrefix,
  callSiteInventoryKey,
  caseKey,
  casesPrefix,
  confirmPlanKey,
  confirmPrefix,
  factKey,
  factsPrefix,
  judgementKey,
  judgementsPrefix,
  projectKey,
  reportKey,
  reportsPrefix,
  runJudgementsPrefix,
  runKey,
  runsPrefix,
  setupPrefix,
  setupStateKey,
  stepKey,
  stepsPrefix,
  verdictKey,
  verdictsPrefix,
} from "./keys.js";

describe("key builders", () => {
  it.each([
    ["projectKey", projectKey("project"), "project/project.json"],
    ["setupPrefix", setupPrefix("project"), "project/setup/"],
    [
      "setupStateKey",
      setupStateKey("project"),
      "project/setup/setup-state.json",
    ],
    [
      "callSiteInventoryKey",
      callSiteInventoryKey("project"),
      "project/setup/call-site-inventory.json",
    ],
    ["casesPrefix", casesPrefix("project"), "project/cases/"],
    ["caseKey", caseKey("project", "case"), "project/cases/case.json"],
    ["stepsPrefix", stepsPrefix("project"), "project/steps/"],
    ["stepKey", stepKey("project", "step"), "project/steps/step.json"],
    ["factsPrefix", factsPrefix("project"), "project/facts/"],
    ["factKey", factKey("project", "fact"), "project/facts/fact.json"],
    ["judgementsPrefix", judgementsPrefix("project"), "project/judgements/"],
    [
      "runJudgementsPrefix",
      runJudgementsPrefix("project", "run"),
      "project/judgements/run/",
    ],
    [
      "judgementKey",
      judgementKey("project", "run", 7),
      "project/judgements/run/invocation-007.json",
    ],
    ["budgetPrefix", budgetPrefix("project"), "project/budget/"],
    ["budgetKey", budgetKey("project", "run"), "project/budget/run.json"],
    ["confirmPrefix", confirmPrefix("project"), "project/confirm/"],
    [
      "confirmPlanKey",
      confirmPlanKey("project", "family"),
      "project/confirm/family/plan.json",
    ],
    ["verdictsPrefix", verdictsPrefix("project"), "project/verdicts/"],
    [
      "verdictKey",
      verdictKey("project", "family"),
      "project/verdicts/family.json",
    ],
    ["runsPrefix", runsPrefix("project"), "project/runs/"],
    ["runKey", runKey("project", "run"), "project/runs/run.json"],
    ["reportsPrefix", reportsPrefix("project"), "project/reports/"],
    [
      "reportKey",
      reportKey("project", "summary.md"),
      "project/reports/summary.md",
    ],
  ])("%s returns a logical store key", (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  const unsafeSegments = [
    "..",
    "a/b",
    "a\\b",
    "/absolute",
    "C:\\absolute",
    "a\0b",
    "",
    ".",
    ".rightmodeler-store",
    ".rightmodeler-store.lock",
  ];
  const guardedArguments: ReadonlyArray<{
    name: string;
    build: (unsafe: string) => string;
  }> = [
    { name: "projectKey projectId", build: (value) => projectKey(value) },
    { name: "setupPrefix projectId", build: (value) => setupPrefix(value) },
    { name: "setupStateKey projectId", build: (value) => setupStateKey(value) },
    {
      name: "callSiteInventoryKey projectId",
      build: (value) => callSiteInventoryKey(value),
    },
    { name: "casesPrefix projectId", build: (value) => casesPrefix(value) },
    { name: "caseKey projectId", build: (value) => caseKey(value, "case") },
    { name: "caseKey caseId", build: (value) => caseKey("project", value) },
    { name: "stepsPrefix projectId", build: (value) => stepsPrefix(value) },
    { name: "stepKey projectId", build: (value) => stepKey(value, "step") },
    { name: "stepKey stepId", build: (value) => stepKey("project", value) },
    { name: "factsPrefix projectId", build: (value) => factsPrefix(value) },
    { name: "factKey projectId", build: (value) => factKey(value, "fact") },
    { name: "factKey factId", build: (value) => factKey("project", value) },
    {
      name: "judgementsPrefix projectId",
      build: (value) => judgementsPrefix(value),
    },
    {
      name: "runJudgementsPrefix projectId",
      build: (value) => runJudgementsPrefix(value, "run"),
    },
    {
      name: "runJudgementsPrefix runId",
      build: (value) => runJudgementsPrefix("project", value),
    },
    {
      name: "judgementKey projectId",
      build: (value) => judgementKey(value, "run", 1),
    },
    {
      name: "judgementKey runId",
      build: (value) => judgementKey("project", value, 1),
    },
    { name: "budgetPrefix projectId", build: (value) => budgetPrefix(value) },
    { name: "budgetKey projectId", build: (value) => budgetKey(value, "run") },
    { name: "budgetKey runId", build: (value) => budgetKey("project", value) },
    { name: "confirmPrefix projectId", build: (value) => confirmPrefix(value) },
    {
      name: "confirmPlanKey projectId",
      build: (value) => confirmPlanKey(value, "family"),
    },
    {
      name: "confirmPlanKey familyId",
      build: (value) => confirmPlanKey("project", value),
    },
    {
      name: "verdictsPrefix projectId",
      build: (value) => verdictsPrefix(value),
    },
    {
      name: "verdictKey projectId",
      build: (value) => verdictKey(value, "family"),
    },
    {
      name: "verdictKey family",
      build: (value) => verdictKey("project", value),
    },
    { name: "runsPrefix projectId", build: (value) => runsPrefix(value) },
    { name: "runKey projectId", build: (value) => runKey(value, "run") },
    { name: "runKey runId", build: (value) => runKey("project", value) },
    { name: "reportsPrefix projectId", build: (value) => reportsPrefix(value) },
    {
      name: "reportKey projectId",
      build: (value) => reportKey(value, "summary.md"),
    },
    {
      name: "reportKey reportName",
      build: (value) => reportKey("project", value),
    },
  ];

  describe.each(guardedArguments)("$name", ({ build }) => {
    it.each(unsafeSegments)("rejects %j", (unsafe) => {
      expect(() => build(unsafe)).toThrow();
    });
  });

  it("accepts an ordinary segment", () => {
    expect(() => assertSafeSegment("family.v1-2")).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid judgement invocation number %s",
    (invocationNumber) => {
      expect(() => judgementKey("project", "run", invocationNumber)).toThrow();
    },
  );
});

describe("family name keys", () => {
  const unstorable = [
    "chat:summarize",
    'say "hi"',
    "a|b",
    "why?",
    "star*",
    "<tag>",
    "dot.",
    "space ",
    "con",
    "NUL.json",
    "com1",
    "LPT9",
  ];

  it.runIf(process.platform === "win32")(
    "store names Windows cannot hold under their digest",
    () => {
      for (const family of unstorable) {
        expect(verdictKey("project", family)).toMatch(
          /^project\/verdicts\/x-[0-9a-f]{32}\.json$/u,
        );
        expect(confirmPlanKey("project", family)).toMatch(
          /^project\/confirm\/x-[0-9a-f]{32}\/plan\.json$/u,
        );
      }
      expect(verdictKey("project", "chat:summarize")).not.toBe(
        verdictKey("project", "chat:summarise"),
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "let a family named like chat:summarize round-trip through the store",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rightmodeler-keys-"));
      try {
        const store = new FsStore(root);
        const key = verdictKey("project", "chat:summarize");
        await store.putImmutable(key, Buffer.from("verdict"));
        expect(Buffer.from((await store.get(key))!.body).toString()).toBe(
          "verdict",
        );
        expect(await store.list("project/verdicts/")).toEqual([key]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")("keep every name elsewhere", () => {
    for (const family of unstorable) {
      expect(verdictKey("project", family)).toBe(
        `project/verdicts/${family}.json`,
      );
    }
  });

  it("keep ordinary names", () => {
    for (const family of ["summarize", "chat-summarize", "console", "com10"]) {
      expect(verdictKey("project", family)).toBe(
        `project/verdicts/${family}.json`,
      );
    }
  });
});
