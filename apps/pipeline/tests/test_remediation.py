import json
import subprocess
import sys

import pytest

from pipeline.corpus import content_digest
from pipeline.__main__ import validate_schema
from pipeline.remediation import RemediationError, apply, approve, rollback


PATCH = """diff --git a/value.txt b/value.txt
--- a/value.txt
+++ b/value.txt
@@ -1 +1 @@
-before
+after
"""


def _git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=True,
    )


def _repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test User")
    (repo / "value.txt").write_text("before\n")
    _git(repo, "add", "value.txt")
    _git(repo, "commit", "-qm", "baseline")
    return repo


def _evidence(tmp_path, validation_command=None):
    command = validation_command or [sys.executable, "-c", "print('ok')"]
    body = {
        "version": "1",
        "baseline_snapshot_id": "sha256:" + "a" * 64,
        "issue_class": "evaluator",
        "next_action": "fix-evaluator",
        "status": "proven",
        "trigger_case_ids": ["case-1"],
        "proposed_change": {
            "type": "diff",
            "content": PATCH,
            "affected_files": ["value.txt"],
            "validation_commands": [
                {
                    "name": "remediation check",
                    "command": command,
                    "timeout_seconds": 30,
                }
            ],
        },
        "proof": {
            "target_gate_ids": ["quality"],
            "baseline_gate_statuses": {"quality": "fail"},
            "post_fix_snapshot_id": "sha256:" + "b" * 64,
            "holdout_snapshot_id": None,
            "target_improved": True,
            "regressed_gate_ids": [],
            "validation": {
                "status": "passed",
                "commands": ["remediation check"],
                "evidence_refs": ["validation/1"],
            },
        },
        "residual_risks": [],
    }
    evidence = {**body, "evidence_id": content_digest(body)}
    path = tmp_path / "evidence.json"
    path.write_text(json.dumps(evidence))
    validate_schema(evidence, "remediation-evidence")
    return path


def test_apply_and_rollback_restore_the_exact_local_state(tmp_path):
    repo = _repo(tmp_path)
    evidence = _evidence(tmp_path)
    lifecycle = tmp_path / "lifecycle.json"
    revision = _git(repo, "rev-parse", "HEAD").stdout.strip()

    approved = approve(
        evidence,
        repo,
        lifecycle,
        "tester",
        "approve test",
        timestamp="2026-07-13T12:00:00+00:00",
    )
    assert approved["event_type"] == "approved"
    assert approved["repository_revision"] == revision
    assert (repo / "value.txt").read_text() == "before\n"

    applied = apply(
        evidence,
        repo,
        lifecycle,
        "tester",
        timestamp="2026-07-13T12:01:00+00:00",
    )
    assert applied["event_type"] == "applied"
    assert (repo / "value.txt").read_text() == "after\n"
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == revision

    rolled_back = rollback(
        evidence,
        repo,
        lifecycle,
        "tester",
        timestamp="2026-07-13T12:02:00+00:00",
    )
    assert rolled_back["event_type"] == "rolled_back"
    assert (repo / "value.txt").read_text() == "before\n"
    assert _git(repo, "status", "--porcelain").stdout == ""
    events = json.loads(lifecycle.read_text())
    assert [event["event_type"] for event in events] == [
        "approved",
        "applied",
        "rolled_back",
    ]
    for event in events:
        validate_schema(event, "remediation-lifecycle")


def test_apply_failure_restores_pre_apply_state_and_records_event(tmp_path):
    repo = _repo(tmp_path)
    evidence = _evidence(tmp_path, [sys.executable, "-c", "raise SystemExit(1)"])
    lifecycle = tmp_path / "lifecycle.json"
    approve(evidence, repo, lifecycle, "tester", timestamp="2026-07-13T12:00:00+00:00")

    with pytest.raises(RemediationError, match="pre-apply files were restored"):
        apply(evidence, repo, lifecycle, "tester", timestamp="2026-07-13T12:01:00+00:00")

    assert (repo / "value.txt").read_text() == "before\n"
    assert _git(repo, "status", "--porcelain").stdout == ""
    events = json.loads(lifecycle.read_text())
    assert events[-1]["event_type"] == "apply_failed"
    assert events[-1]["restored"] is True


def test_apply_refuses_stale_repository_revision(tmp_path):
    repo = _repo(tmp_path)
    evidence = _evidence(tmp_path)
    lifecycle = tmp_path / "lifecycle.json"
    approve(evidence, repo, lifecycle, "tester", timestamp="2026-07-13T12:00:00+00:00")
    (repo / "other.txt").write_text("later\n")
    _git(repo, "add", "other.txt")
    _git(repo, "commit", "-qm", "later change")

    with pytest.raises(RemediationError, match="revision does not match"):
        apply(evidence, repo, lifecycle, "tester")

    assert (repo / "value.txt").read_text() == "before\n"


def test_rollback_refuses_overlapping_later_edits(tmp_path):
    repo = _repo(tmp_path)
    evidence = _evidence(tmp_path)
    lifecycle = tmp_path / "lifecycle.json"
    approve(evidence, repo, lifecycle, "tester", timestamp="2026-07-13T12:00:00+00:00")
    apply(evidence, repo, lifecycle, "tester", timestamp="2026-07-13T12:01:00+00:00")
    (repo / "value.txt").write_text("later edit\n")

    with pytest.raises(RemediationError, match="digests changed"):
        rollback(evidence, repo, lifecycle, "tester")

    assert (repo / "value.txt").read_text() == "later edit\n"
