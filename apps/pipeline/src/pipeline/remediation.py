"""Guarded local approval, apply, and rollback for proven remediations."""

import hashlib
import json
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from pipeline.corpus import content_digest


class RemediationError(ValueError):
    pass


def _load_evidence(path):
    from pipeline.__main__ import load_json, validate_schema

    evidence = validate_schema(load_json(path), "remediation-evidence")
    body = dict(evidence)
    evidence_id = body.pop("evidence_id")
    if content_digest(body) != evidence_id:
        raise RemediationError("remediation evidence digest does not match its contents")
    return evidence


def _validate_event(event):
    from pipeline.__main__ import validate_schema

    return validate_schema(event, "remediation-lifecycle")


def _load_events(path):
    path = Path(path)
    if not path.exists():
        return []
    try:
        events = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise RemediationError("lifecycle file is not valid JSON") from error
    if not isinstance(events, list):
        raise RemediationError("lifecycle file must contain an event array")
    return [_validate_event(event) for event in events]


def _append_event(path, event):
    path = Path(path)
    events = _load_events(path)
    events.append(_validate_event(event))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(events, indent=2) + "\n")
    return path


def _git(repo, *args, input_text=None):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
    )


def _repo_state(repo):
    root_result = _git(repo, "rev-parse", "--show-toplevel")
    if root_result.returncode != 0:
        raise RemediationError("repository path is not a Git repository")
    root = Path(root_result.stdout.strip()).resolve()
    revision_result = _git(root, "rev-parse", "HEAD")
    if revision_result.returncode != 0:
        raise RemediationError("repository has no readable HEAD revision")
    status = _git(root, "status", "--porcelain", "--untracked-files=all")
    if status.returncode != 0:
        raise RemediationError("could not inspect repository state")
    return root, revision_result.stdout.strip(), status.stdout


def _safe_files(root, files):
    normalized = sorted(set(files))
    for relative in normalized:
        path = Path(relative)
        if not relative or path.is_absolute() or "\\" in relative or ".." in path.parts:
            raise RemediationError(f"unsafe affected file path: {relative}")
        resolved = (root / path).resolve(strict=False)
        if not resolved.is_relative_to(root):
            raise RemediationError(f"affected file escapes repository: {relative}")
        if (root / path).is_symlink():
            raise RemediationError(f"symlinked affected file is not supported: {relative}")
    return normalized


def _status_paths(status):
    paths = []
    for line in status.splitlines():
        if not line:
            continue
        if " -> " in line:
            raise RemediationError("rename status is not supported for remediation apply")
        paths.append(line[3:])
    return sorted(set(paths))


def _assert_clean(status):
    if status:
        raise RemediationError("repository working tree is not clean")


def _file_path(root, relative):
    path = root / relative
    if path.is_symlink():
        raise RemediationError(f"symlinked affected file is not supported: {relative}")
    return path


def _digest_bytes(data):
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def _file_digest(root, relative):
    path = _file_path(root, relative)
    if not path.exists():
        return None
    if not path.is_file():
        raise RemediationError(f"affected path is not a regular file: {relative}")
    return _digest_bytes(path.read_bytes())


def _file_snapshot(root, files):
    snapshot = {}
    for relative in files:
        path = _file_path(root, relative)
        snapshot[relative] = path.read_bytes() if path.exists() else None
    return snapshot


def _file_digests(root, files):
    return {relative: _file_digest(root, relative) for relative in files}


def _restore_files(root, snapshot):
    for relative, data in snapshot.items():
        path = _file_path(root, relative)
        if data is None:
            if path.exists():
                path.unlink()
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def _event(
    evidence,
    event_type,
    actor,
    reason,
    revision,
    affected_files,
    pre_apply_digests,
    post_apply_digests,
    validation,
    restored,
    timestamp=None,
):
    body = {
        "version": "1",
        "evidence_id": evidence["evidence_id"],
        "event_type": event_type,
        "actor": actor,
        "timestamp": timestamp or datetime.now(UTC).isoformat(),
        "reason": reason,
        "repository_revision": revision,
        "affected_files": affected_files,
        "pre_apply_digests": pre_apply_digests,
        "post_apply_digests": post_apply_digests,
        "validation": validation,
        "restored": restored,
    }
    return {**body, "event_id": content_digest(body)}


def _validation_result(spec, root):
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            spec["command"],
            cwd=root,
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
        stdout = error.stdout or ""
        stderr = error.stderr or ""
    except OSError as error:
        exit_code = None
        timed_out = False
        stdout = ""
        stderr = str(error)
    return {
        "name": spec["name"],
        "command": spec["command"],
        "exit_code": exit_code,
        "passed": exit_code == 0,
        "timed_out": timed_out,
        "duration_ms": round((time.perf_counter() - started) * 1000, 3),
        "stdout_summary": str(stdout)[-2000:],
        "stderr_summary": str(stderr)[-2000:],
    }


def _run_validation(root, commands):
    results = []
    for command in commands:
        result = _validation_result(command, root)
        results.append(result)
        if not result["passed"]:
            break
    return {
        "status": "passed" if results and all(result["passed"] for result in results) else "failed",
        "command_results": results,
    }


def _events_for(events, evidence_id):
    return [event for event in events if event["evidence_id"] == evidence_id]


def _require_proven(evidence):
    if evidence["status"] != "proven":
        raise RemediationError("only proven remediation evidence may be approved or applied")
    change = evidence["proposed_change"]
    if change["type"] == "none" or not change["content"]:
        raise RemediationError("proven remediation evidence must contain an actionable change")
    if not change["validation_commands"]:
        raise RemediationError("remediation requires at least one validation command")


def approve(evidence_path, repo_path, lifecycle_path, actor, reason=None, timestamp=None):
    evidence = _load_evidence(evidence_path)
    _require_proven(evidence)
    root, revision, status = _repo_state(repo_path)
    _assert_clean(status)
    affected_files = _safe_files(root, evidence["proposed_change"]["affected_files"])
    events = _events_for(_load_events(lifecycle_path), evidence["evidence_id"])
    if any(event["event_type"] in {"approved", "applied"} for event in events):
        raise RemediationError("remediation already has an active approval or application")
    event = _event(
        evidence,
        "approved",
        actor,
        reason,
        revision,
        affected_files,
        _file_digests(root, affected_files),
        {},
        {"status": "not_run", "command_results": []},
        False,
        timestamp,
    )
    _append_event(lifecycle_path, event)
    return event


def apply(evidence_path, repo_path, lifecycle_path, actor, reason=None, timestamp=None):
    evidence = _load_evidence(evidence_path)
    _require_proven(evidence)
    lifecycle_events = _load_events(lifecycle_path)
    events = _events_for(lifecycle_events, evidence["evidence_id"])
    approval = next(
        (event for event in reversed(events) if event["event_type"] == "approved"), None
    )
    if approval is None:
        raise RemediationError("remediation must be approved before apply")
    if any(event["event_type"] == "applied" for event in events):
        raise RemediationError("remediation is already applied")

    root, revision, status = _repo_state(repo_path)
    _assert_clean(status)
    if revision != approval["repository_revision"]:
        raise RemediationError("repository revision does not match approval evidence")
    affected_files = _safe_files(root, evidence["proposed_change"]["affected_files"])
    pre_apply = _file_digests(root, affected_files)
    if pre_apply != approval["pre_apply_digests"]:
        raise RemediationError("affected file digests do not match approval evidence")
    backup = _file_snapshot(root, affected_files)
    patch = evidence["proposed_change"]["content"]
    checked = _git(
        root,
        "apply",
        "--check",
        "--whitespace=error-all",
        "-",
        input_text=patch,
    )
    if checked.returncode != 0:
        raise RemediationError(f"remediation patch does not apply: {checked.stderr.strip()}")
    applied = _git(root, "apply", "--whitespace=error-all", "-", input_text=patch)
    if applied.returncode != 0:
        raise RemediationError(f"remediation patch failed: {applied.stderr.strip()}")

    changed_files = _status_paths(
        _git(root, "status", "--porcelain", "--untracked-files=all").stdout
    )
    if changed_files != affected_files:
        _restore_files(root, backup)
        raise RemediationError("remediation changed files outside its declared scope")

    post_apply = _file_digests(root, affected_files)
    validation = _run_validation(root, evidence["proposed_change"]["validation_commands"])
    if validation["status"] != "passed":
        current_paths = _status_paths(
            _git(root, "status", "--porcelain", "--untracked-files=all").stdout
        )
        if not set(current_paths).issubset(set(affected_files)):
            raise RemediationError(
                "validation changed files outside remediation scope; manual restoration required"
            )
        _restore_files(root, backup)
        failed_event = _event(
            evidence,
            "apply_failed",
            actor,
            reason or "post-apply validation failed",
            revision,
            affected_files,
            pre_apply,
            post_apply,
            validation,
            True,
            timestamp,
        )
        _append_event(lifecycle_path, failed_event)
        raise RemediationError("post-apply validation failed; pre-apply files were restored")

    event = _event(
        evidence,
        "applied",
        actor,
        reason,
        revision,
        affected_files,
        pre_apply,
        post_apply,
        validation,
        False,
        timestamp,
    )
    _append_event(lifecycle_path, event)
    return event


def rollback(evidence_path, repo_path, lifecycle_path, actor, reason=None, timestamp=None):
    evidence = _load_evidence(evidence_path)
    _require_proven(evidence)
    lifecycle_events = _load_events(lifecycle_path)
    events = _events_for(lifecycle_events, evidence["evidence_id"])
    applied = next((event for event in reversed(events) if event["event_type"] == "applied"), None)
    if applied is None:
        raise RemediationError("remediation has no applied lifecycle event")
    if any(event["event_type"] == "rolled_back" for event in events):
        raise RemediationError("remediation is already rolled back")

    root, revision, status = _repo_state(repo_path)
    if revision != applied["repository_revision"]:
        raise RemediationError("repository revision does not match applied remediation")
    affected_files = _safe_files(root, evidence["proposed_change"]["affected_files"])
    current_paths = _status_paths(status)
    if not set(current_paths).issubset(set(affected_files)):
        raise RemediationError("later edits outside remediation scope prevent rollback")
    current_digests = _file_digests(root, affected_files)
    if current_digests != applied["post_apply_digests"]:
        raise RemediationError("affected file digests changed after remediation apply")

    patch = evidence["proposed_change"]["content"]
    checked = _git(
        root,
        "apply",
        "-R",
        "--check",
        "--whitespace=error-all",
        "-",
        input_text=patch,
    )
    if checked.returncode != 0:
        raise RemediationError(f"remediation rollback does not apply: {checked.stderr.strip()}")
    reversed_patch = _git(
        root,
        "apply",
        "-R",
        "--whitespace=error-all",
        "-",
        input_text=patch,
    )
    if reversed_patch.returncode != 0:
        raise RemediationError(f"remediation rollback failed: {reversed_patch.stderr.strip()}")
    restored_digests = _file_digests(root, affected_files)
    if restored_digests != applied["pre_apply_digests"]:
        raise RemediationError("rollback did not restore the approved pre-apply state")

    event = _event(
        evidence,
        "rolled_back",
        actor,
        reason,
        revision,
        affected_files,
        applied["pre_apply_digests"],
        restored_digests,
        {"status": "not_run", "command_results": []},
        True,
        timestamp,
    )
    _append_event(lifecycle_path, event)
    return event
