import { describe, expect, it } from "vitest";

import {
  createAppliedRemediationLifecycleEvent,
  delegatedCiValidationReason,
  digestFileContent,
  parseRemediationLifecycleEvent,
} from "./remediation.js";

describe("remediation lifecycle evidence", () => {
  it("records contract-shaped pre/post digests and rejects tampered evidence", () => {
    const event = createAppliedRemediationLifecycleEvent({
      runSpecDigest: "a".repeat(64),
      repositoryRevision: "b".repeat(40),
      timestamp: "2026-07-13T12:00:00.000Z",
      files: [
        {
          path: "src/model.ts",
          before: 'export const model = "large";\n',
          after: 'export const model = "small";\n',
        },
      ],
    });

    expect(parseRemediationLifecycleEvent(event)).toEqual(event);
    expect(event).toMatchObject({
      version: "1",
      evidence_id: `sha256:${"a".repeat(64)}`,
      event_type: "applied",
      repository_revision: "b".repeat(40),
      affected_files: ["src/model.ts"],
      pre_apply_digests: {
        "src/model.ts":
          "sha256:903ff182c9ec1573db48f3b2299a2ee52c86a2c5e07b6e89c330c28301553b27",
      },
      post_apply_digests: {
        "src/model.ts":
          "sha256:047548f4b0465d3edb460fedad963e38485eb2db0ad24e18919627fff00de0da",
      },
      reason: delegatedCiValidationReason,
      restored: false,
    });

    expect(() =>
      parseRemediationLifecycleEvent({
        ...event,
        post_apply_digests: {
          "src/model.ts": digestFileContent("tampered\n"),
        },
      }),
    ).toThrow("digest does not match");
  });

  it("pins the raw-byte digest function", () => {
    expect(digestFileContent(Uint8Array.from([0xff, 0x00, 0x61]))).toBe(
      "sha256:f9789675a25a87605b0d60387568e25cda7b568653ecdc42e9248588dc70acd5",
    );
  });

  it("deduplicates repeated affected files", () => {
    const event = createAppliedRemediationLifecycleEvent({
      runSpecDigest: "a".repeat(64),
      repositoryRevision: "b".repeat(40),
      timestamp: "2026-07-13T12:00:00.000Z",
      files: [
        { path: "src/model.ts", before: "before", after: "after" },
        { path: "src/model.ts", before: "before", after: "after" },
      ],
    });

    expect(event.affected_files).toEqual(["src/model.ts"]);
  });

  it("accepts SHA-256 repository revisions", () => {
    const event = createAppliedRemediationLifecycleEvent({
      runSpecDigest: "a".repeat(64),
      repositoryRevision: "b".repeat(64),
      timestamp: "2026-07-13T12:00:00.000Z",
      files: [{ path: "src/model.ts", before: "before", after: "after" }],
    });

    expect(event.repository_revision).toBe("b".repeat(64));
  });
});
