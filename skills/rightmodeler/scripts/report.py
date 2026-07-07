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

    lines.append("## Recommended substitutions")
    lines.append("")
    lines.append(
        "| Step | Family | Current | → Recommended | Savings | Quality | Evidence | Confidence |"
    )
    lines.append("|---|---|---|---|---|---|---|---|")
    for s in steps:
        best = s.get("best")
        if not best:
            continue
        lines.append(
            f"| {s['name'] or s['step_id']} | {s['family']} | `{s['current_model']}` | "
            f"`{best['model']}` | {(best.get('est_savings') or 0):.0%} | "
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
    lines.append("- Costs compared via OpenRouter `usage.cost` (never raw token counts).")
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
                "quality_score": best["score"],
                "verdict": best["verdict"],
                "evidence": s["evaluator"],
                "confidence": confidence(s),
                "decision": (decisions or {}).get(s["step_id"], "proposed"),
            }
        )
    return {"generated_at": results.get("generated_at"), "recommendations": recs}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--decisions")
    ap.add_argument("--out", default=".rightmodeler/report.md")
    args = ap.parse_args()

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
