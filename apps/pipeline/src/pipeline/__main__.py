import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

from jsonschema import validate
from pipeline.corpus import compile_corpus
from pipeline.diagnosis import diagnose_snapshot
from pipeline.drift import approve_drift, detect_drift, publish_corpus
from pipeline.evaluate import evaluate
from pipeline.freeform import evaluate_freeform_candidates
from pipeline.repo_fix import evaluate_repo_fix_candidates
from pipeline.remediation import apply as apply_remediation
from pipeline.remediation import approve as approve_remediation
from pipeline.remediation import rollback as rollback_remediation
from pipeline.structured import evaluate_structured_candidates
from pipeline.trajectory import evaluate_tool_trajectories

ROOT = Path(__file__).resolve().parents[4]
ARTIFACTS = ROOT / ".rightmodeler"
CONTRACTS = ROOT / "packages" / "contracts" / "schemas"


def load_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")
    return path


def load_schema(name):
    return load_json(CONTRACTS / f"{name}.schema.json")


def validate_schema(payload, name):
    validate(instance=payload, schema=load_schema(name))
    return payload


def infer_task_family(run):
    label = run.get("task_family_label")
    if label:
        return label
    prompt = (run.get("prompt") or "").lower()
    tokens = set(re.findall(r"[a-z0-9']+", prompt))
    # Ordered by intentional first-match precedence: when a prompt matches more
    # than one family, the earlier entry wins. Single-word keywords must match a
    # whole-word token; multi-word keywords (containing a space) stay phrase
    # substring checks against the raw lowercased prompt.
    heuristics = [
        ("pr-summary", ("pull request", "pr summary", "summarize this pr")),
        ("bug-fix", ("bug", "fix", "stack trace")),
        ("docs-rewrite", ("rewrite", "documentation", "docs")),
        ("support-draft", ("customer", "support", "reply")),
    ]

    def matches(keyword):
        return keyword in prompt if " " in keyword else keyword in tokens

    return next(
        (
            family
            for family, keywords in heuristics
            if any(matches(keyword) for keyword in keywords)
        ),
        "general",
    )


def normalize_run(run):
    evidence = [
        name
        for name, present in [
            ("success_signal", run.get("success") is not None),
            ("accepted_output", bool(run.get("final_output"))),
            ("human_notes", bool(run.get("notes"))),
        ]
        if present
    ] or ["none"]
    return {
        "id": run["id"],
        "task_family": infer_task_family(run),
        "model": run["model"],
        "success": run.get("success"),
        "cost_usd": run.get("cost_usd"),
        "prompt_excerpt": (run.get("prompt") or "")[:160],
        "evidence_signals": evidence,
    }


def ingest(input_path, output_path):
    bundle = validate_schema(load_json(input_path), "historical-run-bundle")
    return write_json(output_path, bundle)


def analyze(input_path, normalized_output, analysis_output):
    bundle = validate_schema(load_json(input_path), "historical-run-bundle")
    normalized = {
        "version": "1",
        "bundle_id": bundle["bundle_id"],
        "runs": [normalize_run(run) for run in bundle["runs"]],
    }
    validate_schema(normalized, "normalized-run")
    write_json(normalized_output, normalized)

    grouped = defaultdict(list)
    for run in normalized["runs"]:
        grouped[run["task_family"]].append(run)

    task_families = {
        "version": "1",
        "bundle_id": bundle["bundle_id"],
        "task_families": [
            {
                "label": label,
                "run_count": len(runs),
                "current_models": sorted({run["model"] for run in runs}),
                "success_rate": (
                    sum(1 for run in runs if run["success"] is True)
                    / sum(1 for run in runs if run["success"] is not None)
                    if any(run["success"] is not None for run in runs)
                    else None
                ),
                "evidence_types": sorted(
                    {signal for run in runs for signal in run["evidence_signals"]}
                ),
            }
            for label, runs in sorted(grouped.items())
        ],
    }
    validate_schema(task_families, "task-family-summary")
    return write_json(analysis_output, task_families)


def report(analysis_path, output_path, evaluation_path=None):
    task_families = validate_schema(load_json(analysis_path), "task-family-summary")
    recommendations = []
    risk_flags = ["No model substitutions are computed in this bootstrap branch."]
    if evaluation_path and Path(evaluation_path).exists():
        evaluation = load_json(evaluation_path)
        recommendations = evaluation.get("recommendations", [])
        risk_flags = evaluation.get("risk_flags", risk_flags)
    report_payload = {
        "version": "1",
        "generated_at": datetime.now(UTC).isoformat(),
        "summary": {
            "task_family_count": len(task_families["task_families"]),
            "evaluated_run_count": sum(
                family["run_count"] for family in task_families["task_families"]
            ),
            "estimated_savings_usd": 0,
        },
        "recommendations": recommendations,
        "task_families": task_families["task_families"],
        "risk_flags": risk_flags,
    }
    validate_schema(report_payload, "recommendation-report")
    return write_json(output_path, report_payload)


def build_corpus(input_path, definition_path, manifest_output, cases_output):
    bundle = validate_schema(load_json(input_path), "historical-run-bundle")
    definition = validate_schema(load_json(definition_path), "corpus-definition")
    manifest, benchmark_cases = compile_corpus(bundle, definition)
    validate_schema(manifest, "corpus-manifest")
    validate_schema(benchmark_cases, "benchmark-cases")
    write_json(manifest_output, manifest)
    return write_json(cases_output, benchmark_cases)


def detect_corpus_drift(
    parent_manifest_path,
    parent_bundle_path,
    candidate_bundle_path,
    candidate_definition_path,
    output_path,
):
    parent_manifest = validate_schema(load_json(parent_manifest_path), "corpus-manifest")
    parent_bundle = validate_schema(load_json(parent_bundle_path), "historical-run-bundle")
    candidate_bundle = validate_schema(load_json(candidate_bundle_path), "historical-run-bundle")
    candidate_definition = validate_schema(
        load_json(candidate_definition_path), "corpus-definition"
    )
    proposal = detect_drift(parent_manifest, parent_bundle, candidate_bundle, candidate_definition)
    validate_schema(proposal, "corpus-drift-proposal")
    return write_json(output_path, proposal)


def approve_corpus_drift(proposal_path, output_path, actor, reason=None):
    proposal = validate_schema(load_json(proposal_path), "corpus-drift-proposal")
    approved = approve_drift(proposal, actor, reason)
    validate_schema(approved, "corpus-drift-proposal")
    return write_json(output_path, approved)


def publish_reviewed_corpus(
    parent_manifest_path,
    candidate_bundle_path,
    candidate_definition_path,
    proposal_path,
    manifest_output,
    cases_output,
):
    parent_manifest = validate_schema(load_json(parent_manifest_path), "corpus-manifest")
    candidate_bundle = validate_schema(load_json(candidate_bundle_path), "historical-run-bundle")
    candidate_definition = validate_schema(
        load_json(candidate_definition_path), "corpus-definition"
    )
    proposal = validate_schema(load_json(proposal_path), "corpus-drift-proposal")
    manifest, benchmark_cases = publish_corpus(
        parent_manifest,
        candidate_bundle,
        candidate_definition,
        proposal,
    )
    validate_schema(manifest, "corpus-manifest")
    validate_schema(benchmark_cases, "benchmark-cases")
    write_json(manifest_output, manifest)
    return write_json(cases_output, benchmark_cases)


def evaluate_structured(cases_path, candidate_path, output_path):
    cases = validate_schema(load_json(cases_path), "benchmark-cases")
    candidate_bundle = validate_schema(load_json(candidate_path), "candidate-results")
    snapshot = evaluate_structured_candidates(cases, candidate_bundle)
    validate_schema(snapshot, "benchmark-snapshot")
    return write_json(output_path, snapshot)


def evaluate_freeform(cases_path, candidate_path, output_path):
    cases = validate_schema(load_json(cases_path), "benchmark-cases")
    candidate_bundle = validate_schema(load_json(candidate_path), "candidate-results")
    snapshot = evaluate_freeform_candidates(cases, candidate_bundle)
    validate_schema(snapshot, "benchmark-snapshot")
    return write_json(output_path, snapshot)


def evaluate_tool_trajectory(cases_path, candidate_path, output_path):
    cases = validate_schema(load_json(cases_path), "benchmark-cases")
    candidate_bundle = validate_schema(load_json(candidate_path), "candidate-results")
    snapshot = evaluate_tool_trajectories(cases, candidate_bundle)
    validate_schema(snapshot, "benchmark-snapshot")
    return write_json(output_path, snapshot)


def evaluate_repo_fix(cases_path, candidate_path, output_path, repo_path):
    cases = validate_schema(load_json(cases_path), "benchmark-cases")
    candidate_bundle = validate_schema(load_json(candidate_path), "candidate-results")
    snapshot = evaluate_repo_fix_candidates(cases, candidate_bundle, repo_path)
    validate_schema(snapshot, "benchmark-snapshot")
    return write_json(output_path, snapshot)


def evaluate_benchmark(cases_path, candidate_path, output_path, pipeline_family, repo_path):
    if pipeline_family == "structured-check":
        return evaluate_structured(cases_path, candidate_path, output_path)
    if pipeline_family == "reference-freeform":
        return evaluate_freeform(cases_path, candidate_path, output_path)
    if pipeline_family == "tool-trajectory":
        return evaluate_tool_trajectory(cases_path, candidate_path, output_path)
    if pipeline_family == "repo-fix":
        if not repo_path:
            raise ValueError("--repo is required for repo-fix evaluation")
        return evaluate_repo_fix(cases_path, candidate_path, output_path, repo_path)
    raise ValueError(f"unsupported benchmark family: {pipeline_family}")


def diagnose(
    snapshot_path,
    output_path,
    proposal_path=None,
    post_fix_snapshot_path=None,
    holdout_snapshot_path=None,
    validation_path=None,
):
    snapshot = validate_schema(load_json(snapshot_path), "benchmark-snapshot")
    proposal = load_json(proposal_path) if proposal_path else None
    post_fix = (
        validate_schema(load_json(post_fix_snapshot_path), "benchmark-snapshot")
        if post_fix_snapshot_path
        else None
    )
    holdout = (
        validate_schema(load_json(holdout_snapshot_path), "benchmark-snapshot")
        if holdout_snapshot_path
        else None
    )
    validation = load_json(validation_path) if validation_path else None
    evidence = diagnose_snapshot(snapshot, proposal, post_fix, holdout, validation)
    validate_schema(evidence, "remediation-evidence")
    return write_json(output_path, evidence)


def approve(evidence_path, repo_path, lifecycle_path, actor, reason=None):
    event = approve_remediation(evidence_path, repo_path, lifecycle_path, actor, reason)
    validate_schema(event, "remediation-lifecycle")
    return lifecycle_path


def apply(evidence_path, repo_path, lifecycle_path, actor, reason=None):
    event = apply_remediation(evidence_path, repo_path, lifecycle_path, actor, reason)
    validate_schema(event, "remediation-lifecycle")
    return lifecycle_path


def rollback(evidence_path, repo_path, lifecycle_path, actor, reason=None):
    event = rollback_remediation(evidence_path, repo_path, lifecycle_path, actor, reason)
    validate_schema(event, "remediation-lifecycle")
    return lifecycle_path


def smoke():
    sample = {
        "version": "1",
        "bundle_id": "smoke-bundle",
        "runs": [
            {
                "id": "run-1",
                "prompt": "Summarize this PR for the team.",
                "model": "gpt-4.1",
                "final_output": "Summary text",
                "success": True,
                "task_family_label": "pr-summary",
                "cost_usd": 1.24,
            },
            {
                "id": "run-2",
                "prompt": "Draft a support reply for a refund request.",
                "model": "gpt-4o",
                "final_output": "Support draft",
                "success": True,
                "notes": "Accepted by human reviewer",
                "cost_usd": 0.42,
            },
            {
                "id": "run-3",
                "prompt": "Extract the ticket fields as JSON.",
                "model": "gpt-4o",
                "final_output": '{"ticket": 42, "status": "open"}',
                "success": True,
                "task_family_label": "json-extraction",
                "cost_usd": 0.10,
            },
        ],
    }
    ingested = ARTIFACTS / "input" / "smoke-bundle.json"
    normalized = ARTIFACTS / "normalized" / "smoke-normalized.json"
    analysis = ARTIFACTS / "analysis" / "smoke-task-families.json"
    evaluation = ARTIFACTS / "evaluation" / "smoke-evaluation.json"
    report_path = ARTIFACTS / "reports" / "smoke-report.json"
    write_json(ingested, sample)
    ingest(ingested, ingested)
    analyze(ingested, normalized, analysis)
    evaluate(ingested, evaluation)
    report(analysis, report_path, evaluation)
    print(report_path)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="pipeline")
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest_parser = subparsers.add_parser("ingest")
    ingest_parser.add_argument("--input", required=True)
    ingest_parser.add_argument(
        "--output",
        default=str(ARTIFACTS / "input" / "historical-run-bundle.json"),
    )
    ingest_parser.set_defaults(handler=lambda args: (print(ingest(args.input, args.output)), 0)[1])

    analyze_parser = subparsers.add_parser("analyze")
    analyze_parser.add_argument(
        "--input",
        default=str(ARTIFACTS / "input" / "historical-run-bundle.json"),
    )
    analyze_parser.add_argument(
        "--normalized-output",
        default=str(ARTIFACTS / "normalized" / "normalized-runs.json"),
    )
    analyze_parser.add_argument(
        "--analysis-output",
        default=str(ARTIFACTS / "analysis" / "task-families.json"),
    )
    analyze_parser.set_defaults(
        handler=lambda args: (
            print(analyze(args.input, args.normalized_output, args.analysis_output)),
            0,
        )[1]
    )

    evaluate_parser = subparsers.add_parser("evaluate")
    evaluate_parser.add_argument(
        "--input",
        default=str(ARTIFACTS / "input" / "historical-run-bundle.json"),
    )
    evaluate_parser.add_argument(
        "--output",
        default=str(ARTIFACTS / "evaluation" / "evaluation.json"),
    )
    evaluate_parser.set_defaults(
        handler=lambda args: (print(evaluate(args.input, args.output)), 0)[1]
    )

    report_parser = subparsers.add_parser("report")
    report_parser.add_argument(
        "--analysis-input",
        default=str(ARTIFACTS / "analysis" / "task-families.json"),
    )
    report_parser.add_argument(
        "--output",
        default=str(ARTIFACTS / "reports" / "recommendation-report.json"),
    )
    report_parser.add_argument(
        "--evaluation-input",
        default=str(ARTIFACTS / "evaluation" / "evaluation.json"),
    )
    report_parser.set_defaults(
        handler=lambda args: (
            print(report(args.analysis_input, args.output, args.evaluation_input)),
            0,
        )[1]
    )

    corpus_parser = subparsers.add_parser("corpus")
    corpus_subparsers = corpus_parser.add_subparsers(dest="corpus_command", required=True)
    corpus_build_parser = corpus_subparsers.add_parser("build")
    corpus_build_parser.add_argument(
        "--input",
        default=str(ARTIFACTS / "input" / "historical-run-bundle.json"),
    )
    corpus_build_parser.add_argument("--definition", required=True)
    corpus_build_parser.add_argument(
        "--manifest-output",
        default=str(ARTIFACTS / "corpus" / "manifest.json"),
    )
    corpus_build_parser.add_argument(
        "--cases-output",
        default=str(ARTIFACTS / "corpus" / "benchmark-cases.json"),
    )
    corpus_build_parser.set_defaults(
        handler=lambda args: (
            print(
                build_corpus(
                    args.input,
                    args.definition,
                    args.manifest_output,
                    args.cases_output,
                )
            ),
            0,
        )[1]
    )

    corpus_drift_parser = corpus_subparsers.add_parser("detect-drift")
    corpus_drift_parser.add_argument("--parent-manifest", required=True)
    corpus_drift_parser.add_argument("--parent-bundle", required=True)
    corpus_drift_parser.add_argument("--candidate-bundle", required=True)
    corpus_drift_parser.add_argument("--candidate-definition", required=True)
    corpus_drift_parser.add_argument(
        "--output",
        default=str(ARTIFACTS / "corpus" / "drift-proposal.json"),
    )
    corpus_drift_parser.set_defaults(
        handler=lambda args: (
            print(
                detect_corpus_drift(
                    args.parent_manifest,
                    args.parent_bundle,
                    args.candidate_bundle,
                    args.candidate_definition,
                    args.output,
                )
            ),
            0,
        )[1]
    )

    corpus_approve_parser = corpus_subparsers.add_parser("approve-drift")
    corpus_approve_parser.add_argument("--proposal", required=True)
    corpus_approve_parser.add_argument("--output", required=True)
    corpus_approve_parser.add_argument("--actor", required=True)
    corpus_approve_parser.add_argument("--reason")
    corpus_approve_parser.set_defaults(
        handler=lambda args: (
            print(
                approve_corpus_drift(
                    args.proposal,
                    args.output,
                    args.actor,
                    args.reason,
                )
            ),
            0,
        )[1]
    )

    corpus_publish_parser = corpus_subparsers.add_parser("publish")
    corpus_publish_parser.add_argument("--parent-manifest", required=True)
    corpus_publish_parser.add_argument("--candidate-bundle", required=True)
    corpus_publish_parser.add_argument("--candidate-definition", required=True)
    corpus_publish_parser.add_argument("--proposal", required=True)
    corpus_publish_parser.add_argument("--manifest-output", required=True)
    corpus_publish_parser.add_argument("--cases-output", required=True)
    corpus_publish_parser.set_defaults(
        handler=lambda args: (
            print(
                publish_reviewed_corpus(
                    args.parent_manifest,
                    args.candidate_bundle,
                    args.candidate_definition,
                    args.proposal,
                    args.manifest_output,
                    args.cases_output,
                )
            ),
            0,
        )[1]
    )

    benchmark_parser = subparsers.add_parser("benchmark")
    benchmark_subparsers = benchmark_parser.add_subparsers(dest="benchmark_command", required=True)
    benchmark_evaluate_parser = benchmark_subparsers.add_parser("evaluate")
    benchmark_evaluate_parser.add_argument(
        "--cases",
        default=str(ARTIFACTS / "corpus" / "benchmark-cases.json"),
    )
    benchmark_evaluate_parser.add_argument("--candidate", required=True)
    benchmark_evaluate_parser.add_argument(
        "--family",
        choices=["structured-check", "reference-freeform", "tool-trajectory", "repo-fix"],
        default="structured-check",
    )
    benchmark_evaluate_parser.add_argument("--repo")
    benchmark_evaluate_parser.add_argument(
        "--output",
        default=str(ARTIFACTS / "evaluation" / "benchmark-snapshot.json"),
    )
    benchmark_evaluate_parser.set_defaults(
        handler=lambda args: (
            print(
                evaluate_benchmark(
                    args.cases,
                    args.candidate,
                    args.output,
                    args.family,
                    args.repo,
                )
            ),
            0,
        )[1]
    )

    remediation_parser = subparsers.add_parser("remediation")
    remediation_subparsers = remediation_parser.add_subparsers(
        dest="remediation_command", required=True
    )
    remediation_diagnose_parser = remediation_subparsers.add_parser("diagnose")
    remediation_diagnose_parser.add_argument("--snapshot", required=True)
    remediation_diagnose_parser.add_argument("--proposal")
    remediation_diagnose_parser.add_argument("--post-fix-snapshot")
    remediation_diagnose_parser.add_argument("--holdout-snapshot")
    remediation_diagnose_parser.add_argument("--validation")
    remediation_diagnose_parser.add_argument(
        "--output",
        default=str(ARTIFACTS / "remediation" / "evidence.json"),
    )
    remediation_diagnose_parser.set_defaults(
        handler=lambda args: (
            print(
                diagnose(
                    args.snapshot,
                    args.output,
                    args.proposal,
                    args.post_fix_snapshot,
                    args.holdout_snapshot,
                    args.validation,
                )
            ),
            0,
        )[1]
    )

    for command, handler in (
        ("approve", approve),
        ("apply", apply),
        ("rollback", rollback),
    ):
        lifecycle_parser = remediation_subparsers.add_parser(command)
        lifecycle_parser.add_argument("--evidence", required=True)
        lifecycle_parser.add_argument("--repo", required=True)
        lifecycle_parser.add_argument(
            "--lifecycle",
            default=str(ARTIFACTS / "remediation" / "lifecycle.json"),
        )
        lifecycle_parser.add_argument("--actor", required=True)
        lifecycle_parser.add_argument("--reason")
        lifecycle_parser.set_defaults(
            handler=lambda args, handler=handler: (
                print(
                    handler(
                        args.evidence,
                        args.repo,
                        args.lifecycle,
                        args.actor,
                        args.reason,
                    )
                ),
                0,
            )[1]
        )

    smoke_parser = subparsers.add_parser("smoke")
    smoke_parser.set_defaults(handler=lambda _: smoke())

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.handler(args)
    except Exception as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
