"""Render the final recommendation report (Markdown) + machine-readable JSON.

Reads results.json (from orchestrate.py) and, if present, decisions.json (from the
TUI's approve/reject). Produces report.md and recommendations.json.

CLI:
    python report.py results.json --out report.md
"""

from __future__ import annotations

import argparse
import os

from common import dump_json, load_json

# a candidate must clear the quality floor in at least this fraction of a
# family's cases before a swap is recommended — one lucky case is not evidence
PASS_FRAC = 0.75


def _format_cost(value, cost_is_estimate: bool = False) -> str:
    if value is None:
        return "?"
    marker = " est." if cost_is_estimate else ""
    return f"${value:.6f}{marker}"


def family_rollup(steps: list[dict]) -> dict:
    """Aggregate per-(family, candidate) across cases: pass count, scores, savings."""
    fams: dict[str, dict] = {}
    for s in steps:
        fam = s.get("family") or "general"
        f = fams.setdefault(fam, {"current": s.get("current_model"), "n": 0, "cands": {}})
        f["n"] += 1
        for c in s.get("candidates", []):
            if "model" not in c:  # shortlist-only entry (e2e step), never replayed
                continue
            cc = f["cands"].setdefault(
                c["model"], {"passes": 0, "scores": [], "errors": 0, "save": None, "price": None}
            )
            cc["scores"].append(c.get("score") or 0.0)
            cc["passes"] += bool(c.get("passes"))
            cc["errors"] += bool(c.get("error"))
            if cc["save"] is None and c.get("est_savings") is not None:
                cc["save"] = c["est_savings"]
            if cc["price"] is None and c.get("blended_price") is not None:
                cc["price"] = c["blended_price"]
    return fams


def family_recommendations(rollup: dict) -> list[dict]:
    recs = []
    for fam, f in rollup.items():
        viable = []
        for model, cc in f["cands"].items():
            cases = len(cc["scores"])
            if cases and cc["passes"] / cases >= PASS_FRAC:
                viable.append((cc["price"] if cc["price"] is not None else 9e9, model, cc))
        pick = min(viable) if viable else None
        recs.append(
            {
                "family": fam,
                "current_model": f["current"],
                "cases": f["n"],
                "recommended_model": pick[1] if pick else None,
                "pass_rate": (pick[2]["passes"] / len(pick[2]["scores"])) if pick else None,
                "avg_quality": (sum(pick[2]["scores"]) / len(pick[2]["scores"])) if pick else None,
                "estimated_savings": pick[2]["save"] if pick else None,
            }
        )
    return recs


def confidence(step: dict) -> str:
    best = step.get("best")
    if step.get("abstain"):
        return "abstain"
    if not best:
        return "n/a"
    ev = step.get("evaluator")
    score = best.get("score", 0)
    if ev in ("deterministic", "reference") and score >= 0.95 and best.get("order_consistent"):
        return "high"
    if score >= 0.85:
        return "medium"
    return "low"


def render(results: dict, decisions: dict | None) -> str:
    steps = results["steps"]
    decisions = decisions or {}

    lines = ["# Cheaper Models — Recommendation Report", ""]
    lines.append(
        f"_Generated {results.get('generated_at', '')}, quality floor "
        f"{results.get('quality_floor')}._"
    )
    lines.append("")
    lines.append("## Executive summary")
    lines.append(f"- Steps analyzed: **{results['total_steps']}**")
    lines.append(f"- Viable single-shot swaps found: **{results['swappable']}**")
    lines.append(f"- Steps needing E2E code-execution confirmation: **{results['needs_e2e']}**")
    lines.append(f"- Abstained (high risk / no candidate): **{results['abstained']}**")
    avg_save = [s["best"].get("est_savings") or 0 for s in steps if s.get("best")]
    if avg_save:
        lines.append(
            f"- Avg estimated per-step cost reduction on swappable steps: "
            f"**{sum(avg_save) / len(avg_save):.0%}**"
        )
    lines.append("")

    rollup = family_rollup(steps)
    multi = {f: v for f, v in rollup.items() if v["n"] > 1}
    if multi:
        recs = {r["family"]: r for r in family_recommendations(rollup)}
        lines.append("## Per-family results across cases")
        lines.append(
            f"_A swap is recommended only when a candidate clears the quality floor in "
            f"≥{PASS_FRAC:.0%} of a family's cases — a per-step win on one case is noise._"
        )
        lines.append("")
        for fam, f in multi.items():
            lines.append(f"### {fam} — current `{f['current']}` ({f['n']} cases)")
            lines.append("")
            lines.append("| Candidate | Pass | Avg quality | Savings | Errors |")
            lines.append("|---|---|---|---|---|")
            for model, cc in sorted(f["cands"].items(), key=lambda kv: kv[1]["price"] or 9e9):
                cases = len(cc["scores"])
                save = f"{cc['save']:.0%}" if cc["save"] is not None else "?"
                lines.append(
                    f"| `{model}` | {cc['passes']}/{cases} | "
                    f"{sum(cc['scores']) / cases:.2f} | {save} | {cc['errors']} |"
                )
            r = recs[fam]
            if r["recommended_model"]:
                lines.append(
                    f"\n**→ swap to `{r['recommended_model']}`** "
                    f"(passes {r['pass_rate']:.0%} of cases, avg quality "
                    f"{r['avg_quality']:.2f}, ~{(r['estimated_savings'] or 0):.0%} cheaper)"
                )
            else:
                lines.append("\n**→ KEEP** — no candidate cleared the bar")
            lines.append("")

    lines.append("## Recommended substitutions")
    lines.append("")
    lines.append(
        "| Step | Family | Current | → Recommended | Savings | Replay cost | Quality | Evidence | Confidence |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for s in steps:
        best = s.get("best")
        if not best:
            continue
        lines.append(
            f"| {s['name'] or s['step_id']} | {s['family']} | `{s['current_model']}` | "
            f"`{best['model']}` | {(best.get('est_savings') or 0):.0%} | "
            f"{_format_cost(best.get('replay_cost'), best.get('cost_is_estimate', False))} | "
            f"{best['score']:.2f} ({best['verdict']}) | {s['evaluator']} | {confidence(s)} |"
        )
    lines.append("")

    e2e = [s for s in steps if s.get("needs_e2e")]
    if e2e:
        lines.append("## Needs code-execution confirmation (cascade risk)")
        lines.append(
            "These steps are multi-step / tool-calling / looping. Single-shot replay is "
            "not trustworthy — confirm with `run_pipeline.py` before swapping."
        )
        lines.append("")
        for s in e2e:
            cands = ", ".join(f"`{c['id']}`" for c in s.get("candidates", [])[:3])
            lines.append(f"- **{s['name'] or s['step_id']}** ({s['family']}): candidates {cands}")
        lines.append("")

    abst = [s for s in steps if s.get("abstain") or (not s.get("best") and not s.get("needs_e2e"))]
    if abst:
        lines.append("## No substitution recommended")
        for s in abst:
            reason = s.get("abstain_reason", "no cheaper candidate passed the quality floor")
            lines.append(f"- **{s['name'] or s['step_id']}** ({s['family']}): {reason}")
        lines.append("")

    lines.append("## Methodology & caveats")
    lines.append(
        "- Judge is reference-guided, cross-family, position-swapped; tool calls get a "
        "deterministic pre-check. Verdicts: equivalent / minor_drift / divergent."
    )
    lines.append(
        "- Costs use provider-reported charges when available and catalog/usage-derived "
        "estimates otherwise (never raw token counts across models)."
    )
    lines.append(
        "- Savings are per-step estimates from blended token pricing; real savings depend "
        "on traffic mix. Confirm E2E-flagged steps before rollout."
    )
    return "\n".join(lines)


def machine_json(results: dict, decisions: dict | None) -> dict:
    recs = []
    for s in results["steps"]:
        best = s.get("best")
        if not best:
            continue
        recs.append(
            {
                "step_id": s["step_id"],
                "family": s["family"],
                "current_model": s["current_model"],
                "recommended_model": best["model"],
                "estimated_savings": best.get("est_savings"),
                "replay_cost": best.get("replay_cost"),
                "cost_is_estimate": bool(best.get("cost_is_estimate")),
                "quality_score": best["score"],
                "verdict": best["verdict"],
                "evidence": s["evaluator"],
                "confidence": confidence(s),
                "decision": (decisions or {}).get(s["step_id"], "proposed"),
            }
        )
    return {
        "generated_at": results.get("generated_at"),
        "recommendations": recs,
        "family_recommendations": family_recommendations(family_rollup(results["steps"])),
    }


def render_snapshot(snapshot: dict) -> str:
    lines = ["# Rightmodeler Benchmark Snapshot", ""]
    lines.append(f"- Snapshot: `{snapshot['snapshot_id']}`")
    lines.append(f"- Corpus: `{snapshot['corpus_version_id']}`")
    lines.append(f"- Candidate: `{snapshot['candidate']['model']}`")
    lines.append(
        f"- Cases: {snapshot['summary']['total_cases']} total, "
        f"{snapshot['summary']['pass_count']} pass, "
        f"{snapshot['summary']['fail_count']} fail, "
        f"{snapshot['summary']['abstain_count']} abstain"
    )
    lines.append(f"- Coverage: {snapshot['summary']['coverage']:.0%}")
    lines.append("")
    lines.append("## Release gates")
    lines.append("")
    lines.append("| Gate | Status | Observed | Threshold | Evidence |")
    lines.append("|---|---|---:|---:|---|")
    for gate in snapshot["gates"]:
        evidence = ", ".join(f"`{ref}`" for ref in gate["evidence_refs"]) or "none"
        observed = gate["observed"] if gate["observed"] is not None else "n/a"
        threshold = gate["threshold"] if gate["threshold"] is not None else "n/a"
        lines.append(
            f"| `{gate['id']}` | **{gate['status']}** | {observed} | {threshold} | {evidence} |"
        )
    lines.append("")
    lines.append("## Scorecards")
    lines.append("")
    for name, metric in snapshot["scorecards"].items():
        if name == "quality":
            metric = metric["overall"]
        value = metric.get("value", metric.get("level", "n/a"))
        status = metric.get("status", "n/a")
        lines.append(f"- **{name}**: {value} ({status})")
    lines.append("")
    lines.append(
        f"Timing availability: **{snapshot['timing']['availability']}**. "
        f"Total candidate cost: **${snapshot['cost']['total_cost_usd']:.6f}**."
    )
    return "\n".join(lines)


def snapshot_machine_json(snapshot: dict) -> dict:
    return {
        "snapshot_id": snapshot["snapshot_id"],
        "corpus_version_id": snapshot["corpus_version_id"],
        "candidate": snapshot["candidate"],
        "summary": snapshot["summary"],
        "timing": snapshot["timing"],
        "cost": snapshot["cost"],
        "scorecards": snapshot["scorecards"],
        "gates": snapshot["gates"],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results", nargs="?")
    ap.add_argument("--snapshot")
    ap.add_argument("--decisions")
    ap.add_argument("--out", default=".rightmodeler/report.md")
    args = ap.parse_args()

    if not args.results and not args.snapshot:
        ap.error("provide results or --snapshot")
    if args.snapshot:
        snapshot = load_json(args.snapshot)
        md = render_snapshot(snapshot)
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w") as f:
            f.write(md)
        jpath = os.path.splitext(args.out)[0].replace("report", "recommendations") + ".json"
        dump_json(snapshot_machine_json(snapshot), jpath)
        print(f"wrote {args.out} and {jpath}")
        return 0

    results = load_json(args.results)
    decisions = None
    dpath = args.decisions or os.path.join(os.path.dirname(args.results) or ".", "decisions.json")
    if os.path.exists(dpath):
        decisions = load_json(dpath)

    md = render(results, decisions)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        f.write(md)
    jpath = os.path.splitext(args.out)[0].replace("report", "recommendations") + ".json"
    dump_json(machine_json(results, decisions), jpath)
    print(f"wrote {args.out} and {jpath}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
