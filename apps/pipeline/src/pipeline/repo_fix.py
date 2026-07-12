"""Validate imported repository patches in disposable Git worktrees."""

import subprocess
import tempfile
import time
from pathlib import Path

from pipeline.corpus import content_digest
from pipeline.snapshot import build_snapshot, match_candidate_results


SUMMARY_LIMIT = 2000


def _summarize(value):
    if isinstance(value, bytes):
        value = value.decode(errors="replace")
    return (value or "").strip()[:SUMMARY_LIMIT]


def _run_git(repo, *args, input_text=None):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
    )


def _repository_state(repo):
    root = _run_git(repo, "rev-parse", "--show-toplevel")
    if root.returncode != 0:
        raise ValueError("repository path is not a Git repository")
    status = _run_git(repo, "status", "--porcelain", "--untracked-files=all")
    if status.returncode != 0:
        raise ValueError("could not inspect repository state")
    if status.stdout:
        raise ValueError("repository working tree is not clean")
    revision = _run_git(repo, "rev-parse", "HEAD")
    if revision.returncode != 0:
        raise ValueError("repository has no readable HEAD revision")
    return Path(root.stdout.strip()).resolve(), revision.stdout.strip()


def _validate_affected_files(affected_files):
    normalized = sorted(set(affected_files))
    for path in normalized:
        path_parts = Path(path).parts
        if not path or path.startswith("/") or "\\" in path or ".." in path_parts:
            raise ValueError(f"unsafe affected file path: {path}")
    return normalized


def _validation_result(spec, worktree):
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            spec["command"],
            cwd=worktree,
            capture_output=True,
            text=True,
            timeout=spec["timeout_seconds"],
            check=False,
        )
        exit_code = completed.returncode
        timed_out = False
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as error:
        exit_code = None
        timed_out = True
        stdout = error.stdout
        stderr = error.stderr
    except OSError as error:
        exit_code = None
        timed_out = False
        stdout = ""
        stderr = str(error)
    duration_ms = round((time.perf_counter() - started) * 1000, 3)
    return {
        "name": spec["name"],
        "command": spec["command"],
        "exit_code": exit_code,
        "passed": exit_code == 0,
        "timed_out": timed_out,
        "stdout_summary": _summarize(stdout),
        "stderr_summary": _summarize(stderr),
        "duration_ms": duration_ms,
    }


def _run_validation_commands(worktree, commands):
    started = time.perf_counter()
    results = [_validation_result(command, worktree) for command in commands]
    return {
        "commands": results,
        "all_passed": bool(results) and all(result["passed"] for result in results),
        "duration_ms": round((time.perf_counter() - started) * 1000, 3),
    }


def _repo_fix_evidence(
    revision,
    patch,
    affected_files,
    patch_applied,
    scope_matches,
    patch_error,
    validation,
):
    return {
        "repository_revision": revision,
        "patch_digest": content_digest({"patch": patch}),
        "affected_files": affected_files,
        "patch_applied": patch_applied,
        "scope_matches": scope_matches,
        "patch_error": patch_error,
        "validation": validation,
    }


def _abstention(case, result, reason):
    return {
        "case_id": case["case_id"],
        "pipeline_family": case["pipeline_family"],
        "split": case["split"],
        "terminal_verdict": "abstain",
        "evidence_type": "abstain",
        "evaluator": "abstain",
        "checks": [],
        "failure_code": None,
        "abstention_reason": reason,
        "timing": {
            "availability": "available" if result.get("duration_ms") is not None else "unavailable",
            "duration_ms": result.get("duration_ms"),
        },
        "cost_usd": result["cost_usd"],
        "evidence_refs": sorted(result.get("evidence_refs", [])),
        "trajectory": None,
        "repo_fix": None,
        "reference": None,
    }


def _missing_result(case):
    return {
        "case_id": case["case_id"],
        "pipeline_family": case["pipeline_family"],
        "split": case["split"],
        "terminal_verdict": "abstain",
        "evidence_type": "abstain",
        "evaluator": "abstain",
        "checks": [],
        "failure_code": None,
        "abstention_reason": "missing_candidate_result",
        "timing": {"availability": "unavailable", "duration_ms": None},
        "cost_usd": 0,
        "evidence_refs": [],
        "trajectory": None,
        "repo_fix": None,
        "reference": None,
    }


def _evaluate_result(case, result, repo, revision):
    repo_fix = result.get("repo_fix")
    if repo_fix is None:
        return _abstention(case, result, "missing_repo_fix")

    declared_revision = repo_fix["repository"]["revision"]
    if declared_revision != revision:
        raise ValueError("candidate repository revision does not match repository HEAD")
    affected_files = _validate_affected_files(repo_fix["affected_files"])
    commands = repo_fix["validation_commands"]
    if not commands:
        raise ValueError("missing validation commands")

    patch = repo_fix["patch"]
    with tempfile.TemporaryDirectory(prefix="rightmodeler-repo-fix-") as temp_dir:
        worktree = Path(temp_dir) / "worktree"
        added = _run_git(repo, "worktree", "add", "--detach", str(worktree), revision)
        if added.returncode != 0:
            raise RuntimeError(f"could not create isolated worktree: {_summarize(added.stderr)}")
        try:
            checked = _run_git(
                worktree,
                "apply",
                "--check",
                "--index",
                "--whitespace=error-all",
                "-",
                input_text=patch,
            )
            if checked.returncode != 0:
                evidence = _repo_fix_evidence(
                    revision,
                    patch,
                    affected_files,
                    False,
                    False,
                    _summarize(checked.stderr or checked.stdout),
                    {"commands": [], "all_passed": False, "duration_ms": 0},
                )
                return _repo_fix_verdict(case, result, evidence, "patch_conflict")

            applied = _run_git(
                worktree,
                "apply",
                "--index",
                "--whitespace=error-all",
                "-",
                input_text=patch,
            )
            if applied.returncode != 0:
                evidence = _repo_fix_evidence(
                    revision,
                    patch,
                    affected_files,
                    False,
                    False,
                    _summarize(applied.stderr or applied.stdout),
                    {"commands": [], "all_passed": False, "duration_ms": 0},
                )
                return _repo_fix_verdict(case, result, evidence, "patch_conflict")

            changed_files = sorted(
                _run_git(worktree, "diff", "--cached", "--name-only", "HEAD")
                .stdout.strip()
                .splitlines()
            )
            scope_matches = changed_files == affected_files
            if not scope_matches:
                evidence = _repo_fix_evidence(
                    revision,
                    patch,
                    affected_files,
                    True,
                    False,
                    "applied patch changed files outside declared scope",
                    {"commands": [], "all_passed": False, "duration_ms": 0},
                )
                return _repo_fix_verdict(case, result, evidence, "patch_scope_mismatch")

            validation = _run_validation_commands(worktree, commands)
            evidence = _repo_fix_evidence(
                revision,
                patch,
                affected_files,
                True,
                True,
                None,
                validation,
            )
            failure_code = None if validation["all_passed"] else "validation_failed"
            return _repo_fix_verdict(case, result, evidence, failure_code)
        finally:
            removed = _run_git(repo, "worktree", "remove", "--force", str(worktree))
            if removed.returncode != 0:
                raise RuntimeError(
                    f"could not remove isolated worktree: {_summarize(removed.stderr)}"
                )


def _repo_fix_verdict(case, result, evidence, failure_code):
    return {
        "case_id": case["case_id"],
        "pipeline_family": case["pipeline_family"],
        "split": case["split"],
        "terminal_verdict": "fail" if failure_code else "pass",
        "evidence_type": "deterministic",
        "evaluator": "repo-fix",
        "checks": [],
        "failure_code": failure_code,
        "abstention_reason": None,
        "timing": {
            "availability": "available" if result.get("duration_ms") is not None else "unavailable",
            "duration_ms": result.get("duration_ms"),
        },
        "cost_usd": result["cost_usd"],
        "evidence_refs": sorted(result.get("evidence_refs", [])),
        "trajectory": None,
        "repo_fix": evidence,
        "reference": None,
    }


def evaluate_repo_fix_candidates(corpus, candidate_bundle, repo_path):
    cases, results_by_case = match_candidate_results(corpus, candidate_bundle, "repo-fix")
    if any(case["required_evidence"] not in {"deterministic", "abstain"} for case in cases):
        raise ValueError("repo-fix evaluation requires deterministic or abstain evidence")
    repo, revision = _repository_state(Path(repo_path).resolve())

    verdicts = []
    for case in cases:
        result = results_by_case.get(case["case_id"])
        if result is None:
            verdicts.append(_missing_result(case))
        elif case["risk"] == "high":
            verdicts.append(_abstention(case, result, "high_risk_case"))
        elif case["required_evidence"] == "abstain":
            verdicts.append(_abstention(case, result, "case_requires_abstention"))
        else:
            verdicts.append(_evaluate_result(case, result, repo, revision))
    return build_snapshot(corpus, candidate_bundle, verdicts)
