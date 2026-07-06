import json
from pathlib import Path

from pipeline.evaluate import build_recommendations, evaluate


def _bundle(runs, bundle_id="test-bundle"):
    return {"version": "1", "bundle_id": bundle_id, "runs": runs}


def test_structured_family_high_confidence():
    runs = [
        {
            "id": f"r{i}",
            "prompt": "extract json",
            "model": "gpt-4.1",
            "final_output": json.dumps({"k": i}),
            "task_family_label": "json-extraction",
        }
        for i in range(5)
    ]
    recs = build_recommendations(_bundle(runs))
    assert len(recs) == 1
    rec = recs[0]
    assert rec["task_family"] == "json-extraction"
    assert rec["evidence_type"] == "deterministic"
    assert rec["confidence"] == "high"
    assert rec["recommended_model"] is None
    assert rec["quality_score"] == 1.0
    assert rec["examples_evaluated"] == 5


def test_fuzzy_family_abstains():
    runs = [
        {
            "id": f"r{i}",
            "prompt": "summarize the PR",
            "model": "gpt-4o",
            "final_output": "A plain english summary.",
            "task_family_label": "pr-summary",
        }
        for i in range(4)
    ]
    recs = build_recommendations(_bundle(runs))
    assert recs[0]["confidence"] == "abstain"
    assert recs[0]["evidence_type"] == "none"
    assert recs[0]["recommended_model"] is None


def test_empty_output_abstains():
    runs = [
        {
            "id": "r0",
            "prompt": "do x",
            "model": "gpt-4o",
            "final_output": "",
            "task_family_label": "blank",
        }
    ]
    recs = build_recommendations(_bundle(runs))
    assert recs[0]["confidence"] == "abstain"
    assert recs[0]["quality_score"] == 0.0


def test_small_structured_sample_is_low():
    runs = [
        {
            "id": "r0",
            "prompt": "json please",
            "model": "gpt-4o",
            "final_output": json.dumps({"ok": True}),
            "task_family_label": "json-extraction",
        }
    ]
    recs = build_recommendations(_bundle(runs))
    assert recs[0]["confidence"] == "low"
    assert recs[0]["evidence_type"] == "deterministic"


def test_evaluate_writes_valid_recommendations(tmp_path):
    runs = [
        {
            "id": "r0",
            "prompt": "json please",
            "model": "gpt-4o",
            "final_output": json.dumps({"ok": True}),
            "task_family_label": "json-extraction",
        },
        {
            "id": "r1",
            "prompt": "summarize",
            "model": "gpt-4o",
            "final_output": "plain text",
            "task_family_label": "pr-summary",
        },
    ]
    bundle_path = tmp_path / "bundle.json"
    bundle_path.write_text(json.dumps(_bundle(runs)))
    out_path = tmp_path / "evaluation.json"
    # evaluate() self-validates the report envelope against the schema; returning
    # without raising means the envelope is valid. Field-level guarantees are the
    # explicit asserts below.
    result = evaluate(str(bundle_path), str(out_path))
    payload = json.loads(Path(result).read_text())
    assert payload["bundle_id"] == "test-bundle"
    assert len(payload["recommendations"]) == 2
    assert all(r["recommended_model"] is None for r in payload["recommendations"])


def test_smoke_stays_green():
    from pipeline.__main__ import smoke

    assert smoke() == 0
