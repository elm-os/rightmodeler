"""rightmodeler agent — a headless scheduled watcher that keeps a pipeline on the right model.

Each run diffs the provider catalog against the run ledger, evaluates only new
(step, candidate) pairs within a hard budget, re-ranks already-scored candidates
for free when prices drop, guards the incumbent model's catalog metadata, and
emits an evidence-backed PR intent when a swap clears the policy gates. The PR
is the only thing that ever leaves the machine.

CLI:
    python agent.py install [--schedule weekly]
    python agent.py uninstall
    python agent.py run [--pipeline P] [--normalized N] [--codebase .]
                        [--catalog fixture.json] [--dry-run] [--live]
    python agent.py status

Spec: docs/specs/rightmodeler-agent-v1.md
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import agent_ledger as ledger
from common import dump_json, eprint, load_json
from shortlist import blended_price, shortlist

POLICY_PATH = Path("rightmodeler.policy.json")
INTENT_DIR = ledger.AGENT_DIR / "intents"

DEFAULT_POLICY = {
    "version": "1",
    "quality_floor": 0.90,
    "min_saving_pct": 20,
    "max_cost_per_run_usd": 5,
    "never_touch": [],
    "schedule": "weekly",
}

ASSUMED_TOKENS_PER_EVAL = 60_000
PRICE_DROP_RERANK_PCT = 15
PRICE_RISE_GUARD_PCT = 10
CRON_MARKER = "# rightmodeler-agent"
CRON_BY_SCHEDULE = {
    "daily": "0 9 * * *",
    "weekly": "0 9 * * 1",
    "monthly": "0 9 1 * *",
}
SKIP_DIRS = {".git", "node_modules", ".rightmodeler", ".venv", "__pycache__", "dist", "build"}


# ---------------------------------------------------------------- policy


def load_policy(path: Path = POLICY_PATH) -> dict:
    policy = load_json(path)
    missing = [k for k in DEFAULT_POLICY if k not in policy]
    if missing:
        raise SystemExit(f"policy {path} missing keys: {', '.join(missing)}")
    return policy


def write_default_policy(path: Path = POLICY_PATH) -> bool:
    if path.exists():
        return False
    path.write_text(json.dumps(DEFAULT_POLICY, indent=2) + "\n", encoding="utf-8")
    return True


def never_touched(policy: dict, *labels: str | None) -> bool:
    patterns = policy.get("never_touch") or []
    return any(fnmatch.fnmatch(label, pat) for pat in patterns for label in labels if label)


# ---------------------------------------------------------------- catalog


class Catalog:
    """OpenRouter-shaped view over a model list, injectable from a fixture."""

    def __init__(self, models: list[dict]):
        self.models = models

    def list_models(self, refresh: bool = False) -> list[dict]:
        return self.models

    def model_info(self, model_id: str) -> dict | None:
        for m in self.models:
            if m.get("id") == model_id or m.get("canonical_slug") == model_id:
                return m
        return None

    def price(self, model_id: str) -> float:
        info = self.model_info(model_id)
        return blended_price(info.get("pricing", {})) if info else 0.0

    @property
    def digest(self) -> str:
        canon = json.dumps(
            sorted(
                (
                    {
                        "id": m.get("id"),
                        "pricing": m.get("pricing"),
                        "context_length": m.get("context_length"),
                    }
                    for m in self.models
                ),
                key=lambda m: m["id"] or "",
            ),
            sort_keys=True,
        )
        return "sha256:" + hashlib.sha256(canon.encode()).hexdigest()


def load_catalog(fixture: Path | None) -> Catalog:
    if fixture:
        return Catalog(load_json(fixture))
    from openrouter import OpenRouter

    return Catalog(OpenRouter().list_models())


# ---------------------------------------------------------------- run planning


def eligible_steps(pipeline: dict, policy: dict) -> tuple[list[dict], list[dict]]:
    """Split pipeline steps into evaluable and skipped-with-reason."""
    evaluable, skipped = [], []
    for step in pipeline.get("steps", []):
        reason = None
        if never_touched(policy, step.get("step_id"), step.get("name"), step.get("family")):
            reason = "never_touch"
        elif step.get("risk") == "high":
            reason = "high_risk"
        elif step.get("replay_mode") != "single_shot":
            reason = "needs_e2e"
        elif not step.get("model"):
            reason = "no_model"
        (skipped if reason else evaluable).append(
            {**step, "skip_reason": reason} if reason else step
        )
    return evaluable, skipped


def incumbent_guard(step: dict, catalog: Catalog, history: dict[str, dict]) -> str | None:
    model = step.get("model")
    if not catalog.model_info(model):
        return "delisted"
    first = history.get(step["step_id"])
    if first and first.get("price"):
        rise_pct = (catalog.price(model) / first["price"] - 1) * 100
        if rise_pct > PRICE_RISE_GUARD_PCT:
            return "price_rise"
    return None


def price_reranks(
    step: dict, catalog: Catalog, prior: dict[tuple[str, str], dict], policy: dict
) -> list[dict]:
    """Re-gate already-scored candidates whose price dropped. Zero token spend."""
    reranks = []
    cur_price = catalog.price(step.get("model"))
    for (sid, cand_id), ev in prior.items():
        if sid != step["step_id"] or ev.get("score") is None:
            continue
        now_price = catalog.price(cand_id)
        if not now_price or not ev.get("price_at_eval"):
            continue
        drop_pct = (1 - now_price / ev["price_at_eval"]) * 100
        if drop_pct < PRICE_DROP_RERANK_PCT:
            continue
        savings_pct = (1 - now_price / cur_price) * 100 if cur_price else 0.0
        reranks.append(
            {
                "step_id": sid,
                "candidate_model": cand_id,
                "price_at_eval": now_price,
                "score": ev["score"],
                "est_savings_pct": round(savings_pct, 2),
                "passes": ev["score"] >= policy["quality_floor"]
                and savings_pct >= policy["min_saving_pct"],
                "complete": True,
                "source": "price_rerank",
                "verdict": ev.get("verdict"),
                "cost_usd": 0.0,
                "abstain_reason": None,
            }
        )
    return reranks


def default_evaluator(step: dict, cand: dict, policy: dict) -> dict:
    from openrouter import OpenRouter
    from orchestrate import evaluate_candidate

    return evaluate_candidate(OpenRouter(), step, cand, policy["quality_floor"], runs=1)


def run_agent(
    policy: dict,
    pipeline: dict,
    normalized: dict,
    catalog: Catalog,
    codebase: Path,
    dry_run: bool = True,
    evaluator=None,
    top: int = 4,
    ledger_path: Path | None = None,
) -> dict:
    """One scheduled run. Returns the ledger entry plus emitted PR intents."""
    ledger_path = ledger_path or ledger.LEDGER_PATH
    entries = ledger.load_entries(ledger_path)
    run_id = ledger.next_run_id(entries)
    prior = ledger.evaluated_pairs(entries)
    answered = ledger.standing_rejections(entries)
    history = ledger.incumbent_history(entries)
    evaluate = evaluator or default_evaluator
    steps_by_id = {s["step_id"]: s for s in normalized.get("steps", [])}

    entry: dict = {
        "version": "1",
        "run_id": run_id,
        "started_at": ledger.utc_now(),
        "catalog_digest": catalog.digest,
        "pipeline_digest": None,
        "outcome": "abstention",
        "outcome_detail": None,
        "spend_usd": 0.0,
        "evaluations": [],
        "incumbents": [],
        "deferred": [],
        "decisions": [],
    }
    intents: list[dict] = []
    evaluable, _skipped = eligible_steps(pipeline, policy)
    budget_remaining = float(policy["max_cost_per_run_usd"])
    guard_by_step: dict[str, str | None] = {}

    pending: list[tuple[dict, dict]] = []
    for step in evaluable:
        sid = step["step_id"]
        guard_by_step[sid] = incumbent_guard(step, catalog, history)
        entry["incumbents"].append(
            {
                "step_id": sid,
                "model": step.get("model"),
                "price": catalog.price(step.get("model")),
                "baseline_score": None,
                "guard": guard_by_step[sid],
            }
        )
        entry["evaluations"].extend(price_reranks(step, catalog, prior, policy))
        norm = steps_by_id.get(sid, {})
        cands = shortlist(
            catalog,
            step.get("model"),
            need_tools=bool(norm.get("tool_calls") or norm.get("available_tools")),
            need_structured=step.get("family") == "structured_extraction",
            top=top,
        )
        for cand in cands:
            pair = (sid, cand["id"])
            if pair in prior or pair in answered:
                continue
            pending.append((step, cand))

    estimates = {
        (s["step_id"], c["id"]): max(c["blended_price"] * ASSUMED_TOKENS_PER_EVAL, 0.001)
        for s, c in pending
    }
    if pending and min(estimates.values()) > budget_remaining:
        entry["outcome"] = "abort"
        entry["outcome_detail"] = (
            "budget too low to evaluate any candidate — raise max_cost_per_run_usd"
        )
        ledger.append_entry(entry, ledger_path)
        ledger.touch_heartbeat(ledger_path.parent / "heartbeat")
        return {"entry": entry, "intents": intents}

    for step, cand in pending:
        sid = step["step_id"]
        est = estimates[(sid, cand["id"])]
        if est > budget_remaining:
            entry["deferred"].append({"step_id": sid, "candidate_model": cand["id"]})
            continue
        norm = steps_by_id.get(sid, {})
        result = evaluate({**step, **norm}, cand, policy)
        cost = result.get("replay_cost") or 0.0
        budget_remaining -= cost if cost > 0 else est
        entry["spend_usd"] = round(entry["spend_usd"] + cost, 6)
        savings_pct = round((cand.get("est_savings_vs_current") or 0.0) * 100, 2)
        score = result.get("score")
        failed = result.get("error") is not None or score is None
        quality_ok = (not failed) and result.get("passes", False)
        # A delisted incumbent must be replaced; savings are not the point then.
        savings_ok = savings_pct >= policy["min_saving_pct"] or guard_by_step.get(sid) == "delisted"
        abstain_reason = None
        if failed:
            abstain_reason = f"evaluation failed: {result.get('error')}"
        elif not quality_ok:
            abstain_reason = "below quality_floor"
        elif not savings_ok:
            abstain_reason = "below min_saving_pct"
        entry["evaluations"].append(
            {
                "step_id": sid,
                "candidate_model": cand["id"],
                "price_at_eval": cand["blended_price"],
                "score": score,
                "est_savings_pct": savings_pct,
                "passes": quality_ok and savings_ok,
                "complete": not failed,
                "source": "replay",
                "verdict": result.get("verdict"),
                "cost_usd": cost,
                "abstain_reason": abstain_reason,
            }
        )

    for step in evaluable:
        sid = step["step_id"]
        passing = [
            ev
            for ev in entry["evaluations"]
            if ev["step_id"] == sid
            and ev["passes"]
            and (sid, ev["candidate_model"]) not in answered
        ]
        if not passing:
            continue
        best = max(passing, key=lambda ev: ev["est_savings_pct"])
        reason = (
            "incumbent_guard"
            if guard_by_step.get(sid)
            else ("price_drop" if best["source"] == "price_rerank" else "new_model")
        )
        intent = build_intent(policy, step, best, reason, run_id, codebase, entry)
        if intent is None:
            continue
        intents.append(intent)
        entry["decisions"].append(
            {
                "step_id": sid,
                "candidate_model": best["candidate_model"],
                "decision": "proposed",
                "pr_ref": None,
            }
        )
        deliver(intent, codebase, dry_run=dry_run)

    if intents:
        entry["outcome"] = "proposal"
    elif entry["deferred"]:
        entry["outcome"] = "deferral"
    entry["outcome_detail"] = entry["outcome_detail"] or digest_line(entry)
    ledger.append_entry(entry, ledger_path)
    ledger.touch_heartbeat(ledger_path.parent / "heartbeat")
    return {"entry": entry, "intents": intents}


# ---------------------------------------------------------------- delivery


def locate_model_refs(codebase: Path, model: str, policy: dict) -> list[dict] | None:
    """Exact occurrences of the model string in tracked-ish text files.

    Returns None when any occurrence sits in a never_touch file, meaning the
    swap must abstain rather than edit around the pattern.
    """
    hits = []
    for path in sorted(codebase.rglob("*")):
        if not path.is_file() or path.stat().st_size > 1_000_000:
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        count = text.count(model)
        if not count:
            continue
        rel = str(path.relative_to(codebase))
        if never_touched(policy, rel):
            return None
        hits.append({"file": rel, "count": count})
    return hits


def branch_name(step_id: str, candidate: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", f"{step_id}-{candidate}".lower()).strip("-")
    return f"rightmodeler/swap-{slug}"


def render_pr_body(policy: dict, step: dict, ev: dict, reason: str, run_id: str) -> str:
    reason_line = {
        "new_model": "a newly listed model cleared your gates",
        "price_drop": "a price drop re-ranked an already-proven candidate",
        "incumbent_guard": "your current model tripped the incumbent metadata guard",
    }[reason]
    receipts = [
        ("Quality score vs floor", f"{ev['score']} vs {policy['quality_floor']}"),
        ("Estimated saving", f"{ev['est_savings_pct']}% (floor {policy['min_saving_pct']}%)"),
        ("Judge verdict", str(ev.get("verdict"))),
        ("Evaluation source", ev["source"]),
        ("Run cost", f"${ev.get('cost_usd', 0.0)}"),
    ]
    rows = "\n".join(f"| {k} | {v} |" for k, v in receipts)
    return (
        f"Swap `{step.get('model')}` for `{ev['candidate_model']}` on step "
        f"`{step['step_id']}` — {reason_line}.\n\n"
        "<details open><summary><h3>Receipts</h3></summary>\n\n"
        f"| Receipt | Value |\n|---|---|\n{rows}\n\n</details>\n\n"
        "<details><summary><h3>Evidence</h3></summary>\n\n"
        f"Ledger entry `{run_id}` in `.rightmodeler/agent/ledger.jsonl` holds the "
        "full evaluation record for this candidate.\n\n</details>\n\n"
        f"<sub>rightmodeler agent · {run_id} · closing this PR is a lasting no "
        "for this swap.</sub>\n"
    )


def build_intent(
    policy: dict,
    step: dict,
    ev: dict,
    reason: str,
    run_id: str,
    codebase: Path,
    entry: dict,
) -> dict | None:
    replacements = locate_model_refs(codebase, step.get("model", ""), policy)
    if replacements is None:
        ev["passes"] = False
        ev["abstain_reason"] = "model reference inside a never_touch file"
        return None
    if not replacements:
        ev["passes"] = False
        ev["abstain_reason"] = "model reference not found in codebase — indirect reference"
        return None
    return {
        "version": "1",
        "run_id": run_id,
        "step_id": step["step_id"],
        "current_model": step.get("model"),
        "candidate_model": ev["candidate_model"],
        "branch": branch_name(step["step_id"], ev["candidate_model"]),
        "title": f"swap {step.get('model')} -> {ev['candidate_model']} ({step['step_id']})",
        "body": render_pr_body(policy, step, ev, reason, run_id),
        "replacements": replacements,
        "receipts": {
            "quality_score": ev["score"],
            "quality_floor": policy["quality_floor"],
            "est_savings_pct": ev["est_savings_pct"],
            "min_saving_pct": policy["min_saving_pct"],
            "sample_size": max(
                sum(1 for e in entry["evaluations"] if e["step_id"] == step["step_id"]), 1
            ),
            "judge": str(ev.get("verdict") or "llm_judge"),
            "run_cost_usd": entry["spend_usd"],
            "corpus_version_id": None,
            "corpus_age_days": None,
        },
        "reason": reason,
        "evidence_ref": run_id,
    }


def deliver(intent: dict, codebase: Path, dry_run: bool = True) -> None:
    intent_path = INTENT_DIR / f"{intent['branch'].rsplit('/', 1)[-1]}.json"
    dump_json(intent, intent_path)
    if dry_run:
        eprint(f"[dry-run] PR intent written to {intent_path}")
        return
    open_draft_pr(intent, codebase)


def open_draft_pr(intent: dict, codebase: Path) -> None:
    """Live delivery: isolated worktree, swap, commit, push, draft PR via gh."""
    existing = subprocess.run(
        ["gh", "pr", "list", "--head", intent["branch"], "--state", "all", "--json", "number"],
        capture_output=True,
        text=True,
        cwd=codebase,
    )
    if existing.returncode == 0 and json.loads(existing.stdout or "[]"):
        eprint(f"[skip] PR already exists for {intent['branch']}")
        return
    worktree = codebase / ".rightmodeler" / "agent" / "worktree"
    subprocess.run(
        ["git", "worktree", "add", "-b", intent["branch"], str(worktree)],
        check=True,
        cwd=codebase,
    )
    try:
        for rep in intent["replacements"]:
            target = worktree / rep["file"]
            target.write_text(
                target.read_text(encoding="utf-8").replace(
                    intent["current_model"], intent["candidate_model"]
                ),
                encoding="utf-8",
            )
        subprocess.run(["git", "add", "-A"], check=True, cwd=worktree)
        subprocess.run(["git", "commit", "-m", intent["title"]], check=True, cwd=worktree)
        subprocess.run(["git", "push", "-u", "origin", intent["branch"]], check=True, cwd=worktree)
        subprocess.run(
            [
                "gh",
                "pr",
                "create",
                "--draft",
                "--head",
                intent["branch"],
                "--title",
                intent["title"],
                "--body",
                intent["body"],
            ],
            check=True,
            cwd=worktree,
        )
    finally:
        subprocess.run(["git", "worktree", "remove", "--force", str(worktree)], cwd=codebase)


# ---------------------------------------------------------------- install / status


def merged_crontab(existing: str, line: str) -> str:
    kept = [ln for ln in existing.splitlines() if CRON_MARKER not in ln]
    return "\n".join([*kept, line]).strip() + "\n"


def removed_crontab(existing: str) -> str:
    kept = [ln for ln in existing.splitlines() if CRON_MARKER not in ln]
    return ("\n".join(kept).strip() + "\n") if any(kept) else ""


def cron_line(schedule: str, project: Path) -> str:
    expr = CRON_BY_SCHEDULE[schedule]
    script = Path(__file__).resolve()
    return f"{expr} cd {project} && {sys.executable} {script} run {CRON_MARKER}"


def read_crontab() -> str:
    proc = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
    return proc.stdout if proc.returncode == 0 else ""


def write_crontab(content: str) -> None:
    subprocess.run(["crontab", "-"], input=content, text=True, check=True)


def cmd_install(args) -> int:
    created = write_default_policy()
    policy = load_policy()
    schedule = args.schedule or policy["schedule"]
    write_crontab(merged_crontab(read_crontab(), cron_line(schedule, Path.cwd())))
    print(f"policy: {POLICY_PATH} ({'created' if created else 'kept existing'})")
    print(f"schedule: {schedule} ({CRON_BY_SCHEDULE[schedule]})")
    print("the agent opens draft PRs only and never merges. uninstall any time.")
    return 0


def cmd_uninstall(_args) -> int:
    write_crontab(removed_crontab(read_crontab()))
    print("schedule removed. policy file and ledger left in place.")
    return 0


def digest_line(entry: dict) -> str:
    checked = len(entry["evaluations"])
    proposals = len(entry["decisions"])
    if proposals:
        return f"checked {checked} candidates, proposed {proposals} swap(s)"
    if checked:
        return f"checked {checked} candidates, none cleared your gates — you're on the right model"
    return "no new models or price changes since last run"


def heartbeat_stale(schedule: str, heartbeat: Path) -> bool:
    if not heartbeat.exists():
        return True
    days = {"daily": 1, "weekly": 7, "monthly": 31}[schedule]
    last = datetime.fromisoformat(heartbeat.read_text().strip())
    return (datetime.now(timezone.utc) - last).days > 2 * days


def cmd_status(_args) -> int:
    entries = ledger.load_entries()
    summary = ledger.summarize(entries)
    policy = load_policy() if POLICY_PATH.exists() else DEFAULT_POLICY
    print(f"runs: {summary['runs']}  proposals: {summary['proposals']}")
    print(f"abstentions: {summary['abstentions']}  deferrals: {summary['deferrals']}")
    print(f"total spend: ${summary['total_spend_usd']}")
    print(f"last run: {summary['last_run_at'] or 'never'} ({summary['last_outcome'] or '-'})")
    if entries:
        print(f"last digest: {entries[-1].get('outcome_detail')}")
    if heartbeat_stale(policy["schedule"], ledger.HEARTBEAT_PATH):
        print("warning: scheduled runs appear to have stopped — check `crontab -l`")
    return 0


def cmd_run(args) -> int:
    if not Path(args.policy).exists():
        eprint(f"no policy at {args.policy} — run `agent.py install` first")
        return 2
    policy = load_policy(Path(args.policy))
    pipeline_path = Path(args.pipeline)
    if not pipeline_path.exists():
        eprint(f"no pipeline analysis at {pipeline_path} — run the skill once first")
        return 2
    catalog = load_catalog(Path(args.catalog) if args.catalog else None)
    result = run_agent(
        policy,
        load_json(pipeline_path),
        load_json(Path(args.normalized)) if Path(args.normalized).exists() else {},
        catalog,
        Path(args.codebase).resolve(),
        dry_run=not args.live,
    )
    print(result["entry"]["outcome_detail"])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="rightmodeler-agent")
    sub = ap.add_subparsers(dest="command", required=True)
    install = sub.add_parser("install")
    install.add_argument("--schedule", choices=sorted(CRON_BY_SCHEDULE))
    install.set_defaults(func=cmd_install)
    sub.add_parser("uninstall").set_defaults(func=cmd_uninstall)
    run = sub.add_parser("run")
    run.add_argument("--policy", default=str(POLICY_PATH))
    run.add_argument("--pipeline", default=".rightmodeler/analysis/pipeline.json")
    run.add_argument("--normalized", default=".rightmodeler/normalized/normalized.json")
    run.add_argument("--codebase", default=".")
    run.add_argument("--catalog", default=None)
    run.add_argument("--live", action="store_true")
    run.set_defaults(func=cmd_run)
    sub.add_parser("status").set_defaults(func=cmd_status)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
