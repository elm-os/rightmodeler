"""Compile reviewed historical runs into immutable benchmark artifacts."""

import hashlib
import json

PIPELINE_FAMILIES = {
    "reference-freeform",
    "structured-check",
    "tool-trajectory",
    "repo-fix",
}


def canonical_json(payload):
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def content_digest(payload):
    encoded = canonical_json(payload).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def compile_corpus(bundle, definition):
    runs = {run["id"]: run for run in bundle["runs"]}
    cases = []
    seen_case_ids = set()

    for case in definition["cases"]:
        case_id = case["case_id"]
        if case_id in seen_case_ids:
            raise ValueError(f"duplicate corpus case: {case_id}")
        seen_case_ids.add(case_id)

        source_run = runs.get(case["source_run_id"])
        if source_run is None:
            raise ValueError(f"source run not found: {case['source_run_id']}")
        if source_run.get("success") is not True:
            raise ValueError(f"source run is not accepted: {case['source_run_id']}")
        if case["pipeline_family"] not in PIPELINE_FAMILIES:
            raise ValueError(f"unsupported pipeline family: {case['pipeline_family']}")

        cases.append(dict(case))

    cases.sort(key=lambda case: case["case_id"])
    manifest_without_digest = {
        "version": definition["version"],
        "corpus_id": definition["corpus_id"],
        "corpus_version": definition["version"],
        "parent_version": definition["parent_version"],
        "source_bundle_id": bundle["bundle_id"],
        "cases": cases,
    }
    digest = content_digest(manifest_without_digest)
    manifest = {**manifest_without_digest, "content_digest": digest}
    benchmark_cases = {
        "version": definition["version"],
        "corpus_version_id": digest,
        "source_bundle_id": bundle["bundle_id"],
        "cases": cases,
    }
    return manifest, benchmark_cases
