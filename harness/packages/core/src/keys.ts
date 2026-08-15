import { posix, win32 } from "node:path";

const reservedStoreSegments = new Set([
  ".rightmodeler-store",
  ".rightmodeler-store.lock",
]);

export function assertSafeSegment(segment: string, label = "segment"): void {
  if (segment.length === 0) {
    throw new Error(`Invalid ${label}: must not be empty`);
  }
  if (segment === "." || segment === "..") {
    throw new Error(`Invalid ${label}: ${JSON.stringify(segment)}`);
  }
  if (segment.includes("\0")) {
    throw new Error(`Invalid ${label}: contains NUL`);
  }
  if (posix.isAbsolute(segment) || win32.isAbsolute(segment)) {
    throw new Error(`Invalid ${label}: must not be absolute`);
  }
  if (segment.includes("/") || segment.includes("\\")) {
    throw new Error(`Invalid ${label}: contains a path separator`);
  }
  if (reservedStoreSegments.has(segment)) {
    throw new Error(`Invalid ${label}: reserved by the store`);
  }
}

function projectPrefix(projectId: string): string {
  assertSafeSegment(projectId, "projectId");
  return `${projectId}/`;
}

export function projectKey(projectId: string): string {
  return `${projectPrefix(projectId)}project.json`;
}

export function setupPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}setup/`;
}

export function setupStateKey(projectId: string): string {
  return `${setupPrefix(projectId)}setup-state.json`;
}

export function callSiteInventoryKey(projectId: string): string {
  return `${setupPrefix(projectId)}call-site-inventory.json`;
}

export function casesPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}cases/`;
}

export function caseKey(projectId: string, caseId: string): string {
  assertSafeSegment(caseId, "caseId");
  return `${casesPrefix(projectId)}${caseId}.json`;
}

export function stepsPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}steps/`;
}

export function stepKey(projectId: string, stepId: string): string {
  assertSafeSegment(stepId, "stepId");
  return `${stepsPrefix(projectId)}${stepId}.json`;
}

export function factsPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}facts/`;
}

export function factKey(projectId: string, factId: string): string {
  assertSafeSegment(factId, "factId");
  return `${factsPrefix(projectId)}${factId}.json`;
}

export function judgementsPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}judgements/`;
}

export function runJudgementsPrefix(projectId: string, runId: string): string {
  assertSafeSegment(runId, "runId");
  return `${judgementsPrefix(projectId)}${runId}/`;
}

export function judgementKey(
  projectId: string,
  runId: string,
  invocationNumber: number,
): string {
  if (!Number.isSafeInteger(invocationNumber) || invocationNumber < 0) {
    throw new Error(
      "Invalid invocationNumber: must be a non-negative safe integer",
    );
  }
  const invocation = String(invocationNumber).padStart(3, "0");
  return `${runJudgementsPrefix(projectId, runId)}invocation-${invocation}.json`;
}

export function budgetPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}budget/`;
}

export function budgetKey(projectId: string, runId: string): string {
  assertSafeSegment(runId, "runId");
  return `${budgetPrefix(projectId)}${runId}.json`;
}

export function confirmPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}confirm/`;
}

export function confirmPlanKey(projectId: string, familyId: string): string {
  assertSafeSegment(familyId, "familyId");
  return `${confirmPrefix(projectId)}${familyId}/plan.json`;
}

export function verdictsPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}verdicts/`;
}

export function verdictKey(projectId: string, family: string): string {
  assertSafeSegment(family, "family");
  return `${verdictsPrefix(projectId)}${family}.json`;
}

export function runsPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}runs/`;
}

export function runKey(projectId: string, runId: string): string {
  assertSafeSegment(runId, "runId");
  return `${runsPrefix(projectId)}${runId}.json`;
}

export function reportsPrefix(projectId: string): string {
  return `${projectPrefix(projectId)}reports/`;
}

export function reportKey(projectId: string, reportName: string): string {
  assertSafeSegment(reportName, "reportName");
  return `${reportsPrefix(projectId)}${reportName}`;
}
