import type { StepRecord } from "@rightmodeler/core";
import type { FamilyVerdict } from "@rightmodeler/kernel";

import type { OwnerResolution, RankedOwner } from "./owners.js";
import { compareText } from "./shared.js";

export interface FamilyBlastRadius {
  readonly familyId: string;
  readonly files: readonly string[];
  readonly downstreamFiles: readonly string[];
  readonly owners: readonly RankedOwner[];
}

type RecommendationVerdict = Pick<FamilyVerdict, "decision" | "familyId">;

function addOwner(owners: Map<string, RankedOwner>, owner: RankedOwner): void {
  const current = owners.get(owner.handle);
  if (current === undefined || owner.source === "codeowners") {
    owners.set(owner.handle, owner);
  }
}

export function blastRadius({
  stepRecords,
  verdicts,
  owners: ownerResolutions,
}: {
  readonly stepRecords: readonly StepRecord[];
  readonly verdicts: readonly RecommendationVerdict[];
  readonly owners: readonly OwnerResolution[];
}): readonly FamilyBlastRadius[] {
  const recordsById = new Map(
    stepRecords.map((record) => [record.stepId, record] as const),
  );
  const ownersByPath = new Map(
    ownerResolutions.map(
      (resolution) => [resolution.path, resolution] as const,
    ),
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
      for (const owner of ownersByPath.get(root.callSite.path)?.owners ?? []) {
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
      for (const owner of ownersByPath.get(record.callSite.path)?.owners ??
        []) {
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
