import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

from jsonschema import validate
from pipeline.evaluate import evaluate

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
