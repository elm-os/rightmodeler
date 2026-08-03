"""Sample accepted outputs for independent human review, then tabulate the audit."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from typing import Any

from common import dump_json, load_json

VERDICTS = ("correct", "incorrect", "ambiguous")
Z_95 = 1.959963984540054


def _digest(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _accepted(value: Any) -> bool:
    if isinstance(value, dict):
        return value.get("accepted") is True
    return value is True


def _case(case_id: Any, task: dict, accepted_output: dict) -> dict:
    if case_id in (None, ""):
        raise ValueError("an accepted output is missing its case ID")
    return {
        "case_id": str(case_id),
        "task": task,
        "accepted_output": accepted_output,
    }


def _source_cases(source: dict) -> list[dict]:
    if isinstance(source.get("steps"), list):
        cases = []
        for step in source["steps"]:
            if not _accepted(step.get("success")) or "output_text" not in step:
                continue
            cases.append(
                _case(
                    step.get("step_id"),
                    {
                        key: step[key]
                        for key in ("system_prompt", "input_messages", "available_tools")
                        if key in step
                    },
                    {
                        key: step[key]
                        for key in ("output_text", "output_messages", "tool_calls")
                        if key in step
                    },
                )
            )
    elif isinstance(source.get("runs"), list):
        cases = []
        for run in source["runs"]:
            if not _accepted(run.get("success")) or "final_output" not in run:
                continue
            cases.append(
                _case(
                    run.get("id"),
                    {key: run[key] for key in ("system_prompt", "prompt") if key in run},
                    {"output_text": run["final_output"]},
                )
            )
    else:
        raise ValueError("expected a historical run bundle or skill normalized trace")

    if not cases:
        raise ValueError(
            "no accepted outputs found; use the source bundle, not an output-free summary"
        )
    case_ids = [case["case_id"] for case in cases]
    if len(case_ids) != len(set(case_ids)):
        raise ValueError("accepted output case IDs must be unique")
    return cases


def _corpus_cases(source_cases: list[dict], corpus: dict) -> list[dict]:
    by_source_id = {case["case_id"]: case for case in source_cases}
    cases = []
    for corpus_case in corpus.get("cases", []):
        source_id = str(corpus_case.get("source_run_id", ""))
        source_case = by_source_id.get(source_id)
        if source_case is None:
            raise ValueError(f"corpus source run has no accepted output: {source_id}")
        cases.append(
            {
                **source_case,
                "case_id": str(corpus_case["case_id"]),
                "source_run_id": source_id,
            }
        )
    if not cases:
        raise ValueError("corpus contains no cases")
    case_ids = [case["case_id"] for case in cases]
    if len(case_ids) != len(set(case_ids)):
        raise ValueError("corpus case IDs must be unique")
    return cases


def build_worksheet(
    source: dict,
    sample_size: int,
    seed: int,
    corpus: dict | None = None,
) -> dict:
    cases = _source_cases(source)
    if corpus is not None:
        source_bundle_id = source.get("bundle_id")
        if corpus.get("source_bundle_id") != source_bundle_id:
            raise ValueError("corpus and source bundle IDs do not match")
        cases = _corpus_cases(cases, corpus)
    if sample_size < 1 or sample_size > len(cases):
        raise ValueError(f"sample size must be between 1 and {len(cases)}")

    sampled = random.Random(seed).sample(cases, sample_size)
    worksheet_cases = [{**case, "review": {"verdict": "", "note": ""}} for case in sampled]
    version_source = corpus if corpus is not None else source
    corpus_version_id = (
        version_source.get("corpus_version_id")
        or version_source.get("content_digest")
        or _digest(version_source)
    )
    return {
        "version": "1",
        "kind": "rightmodeler-reference-audit-worksheet",
        "corpus_version_id": corpus_version_id,
        "source_bundle_id": source.get("bundle_id"),
        "seed": seed,
        "sampling_method": "seeded uniform random sample without replacement",
        "population_size": len(cases),
        "sample_size": sample_size,
        "sample_digest": _digest(sampled),
        "instructions": (
            "Before consulting any judge output, set each review verdict to correct, "
            "incorrect, or ambiguous, and record a note."
        ),
        "cases": worksheet_cases,
    }


def _wilson_interval(successes: int, total: int) -> tuple[float, float]:
    rate = successes / total
    denominator = 1 + Z_95**2 / total
    center = (rate + Z_95**2 / (2 * total)) / denominator
    margin = Z_95 * math.sqrt((rate * (1 - rate) + Z_95**2 / (4 * total)) / total) / denominator
    return max(0.0, center - margin), min(1.0, center + margin)


def tabulate_worksheet(worksheet: dict, auditor: str | None = None) -> dict:
    if worksheet.get("kind") != "rightmodeler-reference-audit-worksheet":
        raise ValueError("not a rightmodeler reference audit worksheet")
    cases = worksheet.get("cases")
    if not isinstance(cases, list) or len(cases) != worksheet.get("sample_size"):
        raise ValueError("worksheet sample size does not match its cases")

    sampled = [{key: value for key, value in case.items() if key != "review"} for case in cases]
    if _digest(sampled) != worksheet.get("sample_digest"):
        raise ValueError("worksheet task or accepted output changed after sampling")

    counts = {verdict: 0 for verdict in VERDICTS}
    reviews = []
    for case in cases:
        review = case.get("review", {})
        verdict = review.get("verdict")
        if verdict not in VERDICTS:
            raise ValueError(f"case {case.get('case_id')} has no valid review verdict")
        counts[verdict] += 1
        reviews.append(
            {
                "case_id": case["case_id"],
                "verdict": verdict,
                "note": review.get("note", ""),
            }
        )

    total = len(cases)
    disagreements = counts["incorrect"] + counts["ambiguous"]
    rate = disagreements / total
    low, high = _wilson_interval(disagreements, total)
    return {
        "version": "1",
        "kind": "rightmodeler-reference-audit-result",
        # Who reviewed matters: a model verdict and a human verdict do not carry the same
        # weight, and a model auditor can share a blind spot with whatever produced the
        # accepted output. Unset means unrecorded, which is weaker evidence than either.
        "auditor": auditor,
        "corpus_version_id": worksheet["corpus_version_id"],
        "source_bundle_id": worksheet.get("source_bundle_id"),
        "seed": worksheet["seed"],
        "sampling_method": worksheet["sampling_method"],
        "population_size": worksheet["population_size"],
        "sample_size": total,
        "sample_digest": worksheet["sample_digest"],
        "verdict_counts": counts,
        "reviews": reviews,
        "disagreement": {
            "definition": "incorrect + ambiguous",
            "count": disagreements,
            "rate": rate,
            "confidence_interval_95": {
                "method": "Wilson score",
                "low": low,
                "high": high,
            },
        },
        "reference_correctness_ceiling": {
            "estimate": 1 - rate,
            "confidence_interval_95": {
                "method": "Wilson score complement",
                "low": 1 - high,
                "high": 1 - low,
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)

    sample = commands.add_parser("sample")
    sample.add_argument("source")
    sample.add_argument("--corpus")
    sample.add_argument("--size", type=int, required=True)
    sample.add_argument("--seed", type=int, required=True)
    sample.add_argument("--out", required=True)

    tabulate = commands.add_parser("tabulate")
    tabulate.add_argument("worksheet")
    tabulate.add_argument("--out", required=True)
    tabulate.add_argument(
        "--auditor",
        help="who reviewed, for example 'human:alex' or 'model:gpt-5.6-sol'. "
        "A model verdict and a human verdict are not equivalent evidence.",
    )

    args = parser.parse_args()
    try:
        if args.command == "sample":
            worksheet = build_worksheet(
                load_json(args.source),
                args.size,
                args.seed,
                load_json(args.corpus) if args.corpus else None,
            )
            dump_json(worksheet, args.out)
            print("sampled case IDs:", ", ".join(case["case_id"] for case in worksheet["cases"]))
        else:
            result = tabulate_worksheet(load_json(args.worksheet), args.auditor)
            dump_json(result, args.out)
            print(
                "reference disagreement:",
                f"{result['disagreement']['rate']:.1%}",
                f"(95% CI {result['disagreement']['confidence_interval_95']['low']:.1%}"
                f" to {result['disagreement']['confidence_interval_95']['high']:.1%})",
            )
    except (KeyError, TypeError, ValueError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
