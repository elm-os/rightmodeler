"""Run the local imported-result workflow through the pipeline CLI."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from common import dump_json


def _run(command, cwd):
    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"command failed ({completed.returncode}): {detail}")
    return completed


def run_workflow(
    repo,
    cases,
    candidate,
    family,
    snapshot_out,
    report_out,
    summary_out,
    repo_target=None,
):
    repo = Path(repo).resolve()
    pipeline_project = repo / "apps" / "pipeline"
    if not pipeline_project.is_dir():
        raise RuntimeError(f"pipeline project not found under repository: {pipeline_project}")
    snapshot_out = Path(snapshot_out)
    report_out = Path(report_out)
    summary_out = Path(summary_out)
    evaluate_command = [
        "uv",
        "run",
        "--project",
        str(pipeline_project),
        "python",
        "-m",
        "pipeline",
        "benchmark",
        "evaluate",
        "--family",
        family,
        "--cases",
        str(cases),
        "--candidate",
        str(candidate),
        "--output",
        str(snapshot_out),
    ]
    if family == "repo-fix":
        if not repo_target:
            raise RuntimeError("repo-fix workflow requires --repo-target")
        evaluate_command.extend(["--repo", str(repo_target)])
    _run(evaluate_command, repo)

    report_script = Path(__file__).resolve().parent / "report.py"
    _run(
        [
            sys.executable,
            str(report_script),
            "--snapshot",
            str(snapshot_out),
            "--out",
            str(report_out),
        ],
        repo,
    )
    summary = {
        "version": "1",
        "mode": "offline-imported",
        "snapshot": str(snapshot_out),
        "report": str(report_out),
        "actions": {
            "replay": "explicit",
            "diagnose": "explicit",
            "approve": "explicit",
            "apply": "explicit",
            "rollback": "explicit",
            "corpus_publish": "explicit",
        },
    }
    dump_json(summary, summary_out)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument(
        "--family",
        choices=["structured-check", "reference-freeform", "tool-trajectory", "repo-fix"],
        default="structured-check",
    )
    parser.add_argument("--repo-target")
    parser.add_argument(
        "--snapshot-out",
        default=".rightmodeler/evaluation/benchmark-snapshot.json",
    )
    parser.add_argument("--report-out", default=".rightmodeler/reports/benchmark-report.md")
    parser.add_argument("--summary-out", default=".rightmodeler/workflow.json")
    args = parser.parse_args()
    summary = run_workflow(
        args.repo,
        args.cases,
        args.candidate,
        args.family,
        args.snapshot_out,
        args.report_out,
        args.summary_out,
        args.repo_target,
    )
    print(summary["snapshot"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
