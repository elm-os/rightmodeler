import { createHash } from "node:crypto";

import {
  canonicalJson,
  factSchema,
  factsPrefix,
  jsonValueSchema,
  lifecycleEventSchema,
  type JsonValue,
  type LifecycleEvent,
  type Store,
} from "@rightmodeler/core";
import { z } from "zod";

import { assertContractArtifact } from "../contract-validation.js";

const contentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const repositoryRevisionSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const fileDigestSchema = contentDigestSchema.nullable();
const fileDigestMapSchema = z.record(z.string().min(1), fileDigestSchema);
const lifecycleKindOrder: Record<LifecycleEvent["kind"], number> = {
  apply_started: 0,
  pr_opened: 1,
  review_requested: 2,
  comment_posted: 3,
  reproof_started: 4,
  pr_closed_rejected: 5,
  pr_merged: 6,
  watch_ended: 7,
};

export const delegatedCiValidationReason =
  "Validation is delegated to the target repository CI.";

const validationCommandResultSchema = z.strictObject({
  name: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  exit_code: z.number().int().nullable(),
  passed: z.boolean(),
  timed_out: z.boolean(),
  duration_ms: z.number().nonnegative(),
  stdout_summary: z.string().optional(),
  stderr_summary: z.string().optional(),
});

const remediationValidationSchema = z.strictObject({
  status: z.enum(["not_run", "passed", "failed", "review"]),
  command_results: z.array(validationCommandResultSchema),
});

const remediationLifecycleEventBodySchema = z.strictObject({
  version: z.string(),
  evidence_id: contentDigestSchema,
  event_type: z.enum([
    "approved",
    "applied",
    "apply_failed",
    "rolled_back",
    "rollback_failed",
  ]),
  actor: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  reason: z.string().nullable(),
  repository_revision: repositoryRevisionSchema,
  affected_files: z.array(z.string().min(1)),
  pre_apply_digests: fileDigestMapSchema,
  post_apply_digests: fileDigestMapSchema,
  validation: remediationValidationSchema,
  restored: z.boolean(),
});

export const remediationLifecycleEventSchema =
  remediationLifecycleEventBodySchema.extend({
    event_id: contentDigestSchema,
  });

export type RemediationLifecycleEvent = z.infer<
  typeof remediationLifecycleEventSchema
>;
export type FileDigest = z.infer<typeof fileDigestSchema>;
export type FileDigestMap = z.infer<typeof fileDigestMapSchema>;

export interface RemediationFileChange {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(jsonValueSchema.parse(value)))
    .digest("hex")}`;
}

export function digestFileContent(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isRepositoryRevision(value: string): boolean {
  return repositoryRevisionSchema.safeParse(value).success;
}

export async function readRemediationLifecycleEvents(
  store: Store,
  projectId: string,
): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  for (const key of await store.list(factsPrefix(projectId))) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Missing listed fact: ${key}`);
    const value: unknown = JSON.parse(Buffer.from(entry.body).toString("utf8"));
    const lifecycle = lifecycleEventSchema.safeParse(factSchema.parse(value));
    if (lifecycle.success) events.push(lifecycle.data);
  }
  return events.sort(
    (left, right) =>
      compareText(left.createdAt, right.createdAt) ||
      lifecycleKindOrder[left.kind] - lifecycleKindOrder[right.kind] ||
      compareText(left.eventId, right.eventId),
  );
}

function assertDigestMapKeys(
  event: RemediationLifecycleEvent,
  field: "pre_apply_digests" | "post_apply_digests",
): void {
  const expected = [...event.affected_files].sort();
  const actual = Object.keys(event[field]).sort();
  if (
    expected.length !== actual.length ||
    expected.some((path, index) => path !== actual[index])
  ) {
    throw new Error(`${field} must cover exactly the affected files`);
  }
}

function assertDigestCoverage(event: RemediationLifecycleEvent): void {
  assertDigestMapKeys(event, "pre_apply_digests");
  if (event.event_type === "approved") {
    if (Object.keys(event.post_apply_digests).length > 0) {
      throw new Error("approved remediation must not have post-apply digests");
    }
    return;
  }
  assertDigestMapKeys(event, "post_apply_digests");
}

export function remediationEvidenceId(runSpecDigest: string): string {
  return contentDigestSchema.parse(`sha256:${runSpecDigest}`);
}

export function createRemediationLifecycleEvent(input: {
  readonly evidenceId: string;
  readonly eventType: RemediationLifecycleEvent["event_type"];
  readonly actor: string;
  readonly reason?: string | null;
  readonly repositoryRevision: string;
  readonly affectedFiles: readonly string[];
  readonly preApplyDigests: Readonly<Record<string, FileDigest>>;
  readonly postApplyDigests: Readonly<Record<string, FileDigest>>;
  readonly restored: boolean;
  readonly timestamp?: string;
}): RemediationLifecycleEvent {
  const body = remediationLifecycleEventBodySchema.parse({
    version: "1",
    evidence_id: input.evidenceId,
    event_type: input.eventType,
    actor: input.actor,
    timestamp: input.timestamp ?? new Date().toISOString(),
    reason: input.reason ?? null,
    repository_revision: input.repositoryRevision,
    affected_files: sortedUnique(input.affectedFiles),
    pre_apply_digests: input.preApplyDigests,
    post_apply_digests: input.postApplyDigests,
    validation: { status: "not_run", command_results: [] },
    restored: input.restored,
  });
  const event = remediationLifecycleEventSchema.parse({
    ...body,
    event_id: digestJson(body),
  });
  assertDigestCoverage(event);
  assertContractArtifact("remediation-lifecycle", event);
  return event;
}

export function createAppliedRemediationLifecycleEvent(input: {
  readonly runSpecDigest: string;
  readonly repositoryRevision: string;
  readonly files: readonly RemediationFileChange[];
  readonly timestamp?: string;
}): RemediationLifecycleEvent {
  const files = [...input.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const preApplyDigests = Object.fromEntries(
    files.map(({ path, before }) => [path, digestFileContent(before)]),
  );
  const postApplyDigests = Object.fromEntries(
    files.map(({ path, after }) => [path, digestFileContent(after)]),
  );
  return createRemediationLifecycleEvent({
    evidenceId: remediationEvidenceId(input.runSpecDigest),
    eventType: "applied",
    actor: "rightmodeler",
    reason: delegatedCiValidationReason,
    repositoryRevision: input.repositoryRevision,
    affectedFiles: files.map(({ path }) => path),
    preApplyDigests,
    postApplyDigests,
    restored: false,
    ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
  });
}

export function parseRemediationLifecycleEvent(
  value: unknown,
): RemediationLifecycleEvent {
  const event = remediationLifecycleEventSchema.parse(value);
  const { event_id: eventId, ...body } = event;
  if (digestJson(body) !== eventId) {
    throw new Error(
      "Remediation lifecycle event digest does not match its contents",
    );
  }
  assertDigestCoverage(event);
  return event;
}

export function remediationFromLifecycleDetail(
  detail: JsonValue,
): RemediationLifecycleEvent {
  if (
    typeof detail !== "object" ||
    detail === null ||
    Array.isArray(detail) ||
    !("remediation" in detail)
  ) {
    throw new Error("Lifecycle fact is missing remediation evidence");
  }
  return parseRemediationLifecycleEvent(detail.remediation);
}
