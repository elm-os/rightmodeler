import type { StepRecord } from "@rightmodeler/core";
import type { FamilyVerdict } from "@rightmodeler/kernel";

import type { OwnerResolution, RankedOwner } from "./owners.js";

export interface FamilyBlastRadius {
  readonly familyId: string;
  readonly files: readonly string[];
  readonly downstreamFiles: readonly string[];
  readonly owners: readonly RankedOwner[];
}

type RecommendationVerdict = Pick<FamilyVerdict, "decision" | "familyId">;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownerResolution(record: StepRecord): OwnerResolution | null {
  for (let index = record.analysisHistory.length - 1; index >= 0; index -= 1) {
    const value = record.analysisHistory[index];
    if (!isRecord(value) || value.path !== record.callSite.path) continue;
    if (!Array.isArray(value.owners)) continue;

    const owners: RankedOwner[] = [];
    let valid = true;
    for (const owner of value.owners) {
      if (
        !isRecord(owner) ||
        typeof owner.handle !== "string" ||
        (owner.source !== "codeowners" && owner.source !== "blame")
      ) {
        valid = false;
        break;
      }
      owners.push({ handle: owner.handle, source: owner.source });
    }
    if (valid) return { path: record.callSite.path, owners };
  }
  return null;
}

function addOwner(owners: Map<string, RankedOwner>, owner: RankedOwner): void {
  const current = owners.get(owner.handle);
  if (current === undefined || owner.source === "codeowners") {
    owners.set(owner.handle, owner);
  }
}

export function blastRadius({
  stepRecords,
  verdicts,
}: {
  readonly stepRecords: readonly StepRecord[];
  readonly verdicts: readonly RecommendationVerdict[];
}): readonly FamilyBlastRadius[] {
  const recordsById = new Map(
    stepRecords.map((record) => [record.stepId, record] as const),
  );
  const recommendedFamilies = [
    ...new Set(
      verdicts
        .filter(({ decision }) => decision === "recommend")
        .map(({ familyId }) => familyId),
    ),
  ].sort(compareText);

  return recommendedFamilies.map((familyId) => {
    const roots = stepRecords.filter((record) => record.family === familyId);
    const swappedFiles = new Set(roots.map((record) => record.callSite.path));
    const downstreamFiles = new Set<string>();
    const visited = new Set(roots.map((record) => record.stepId));
    const queue = roots.flatMap((record) => record.downstreamStepIds);
    const owners = new Map<string, RankedOwner>();

    for (const root of roots) {
      for (const owner of ownerResolution(root)?.owners ?? []) {
        addOwner(owners, owner);
      }
    }

    while (queue.length > 0) {
      const stepId = queue.shift()!;
      if (visited.has(stepId)) continue;
      visited.add(stepId);
      const record = recordsById.get(stepId);
      if (record === undefined) continue;

      if (!swappedFiles.has(record.callSite.path)) {
        downstreamFiles.add(record.callSite.path);
      }
      for (const owner of ownerResolution(record)?.owners ?? []) {
        addOwner(owners, owner);
      }
      queue.push(...record.downstreamStepIds);
    }

    return {
      familyId,
      files: [...swappedFiles].sort(compareText),
      downstreamFiles: [...downstreamFiles].sort(compareText),
      owners: [...owners.values()].sort((left, right) =>
        compareText(left.handle, right.handle),
      ),
    };
  });
}
