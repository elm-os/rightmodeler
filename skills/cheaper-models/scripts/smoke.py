from __future__ import annotations

from analyze import analyze
from ingest import detect_format
from report import render


def main():
    detected = detect_format(
        [{"timestamp": "2026-01-01T00:00:00Z", "type": "event", "payload": {"type": "message"}}]
    )
    assert detected == "codex_cli", detected

    normalized = {
        "source_format": "codex_cli",
        "steps": [
            {
                "step_id": "s1",
                "order": 0,
                "kind": "llm",
                "name": "summarize change",
                "model": "openai/gpt-4o",
                "system_prompt": "Summarize the diff.",
                "input_messages": [
                    {"role": "user", "content": "Summarize this pull request diff."}
                ],
                "tool_calls": [],
                "output_text": "Summary",
                "success": {"accepted": True, "scores": {"human": 1}},
                "cost_usd": 0.42,
            }
        ],
    }
    pipeline = analyze(normalized, None)
    assert pipeline["total_steps"] == 1
    assert pipeline["single_shot_steps"] == 1

    report = render(
        {
            "generated_at": "2026-01-01T00:00:00Z",
            "quality_floor": 0.9,
            "total_steps": 1,
            "swappable": 1,
            "needs_e2e": 0,
            "abstained": 0,
            "steps": [
                {
                    "step_id": "s1",
                    "name": "summarize change",
                    "family": "pr_summary",
                    "current_model": "openai/gpt-4o",
                    "evaluator": "reference",
                    "best": {
                        "model": "openai/gpt-4o-mini",
                        "est_savings": 0.5,
                        "score": 1.0,
                        "verdict": "equivalent",
                        "order_consistent": True,
                    },
                }
            ],
        },
        None,
    )
    assert "Recommendation Report" in report


if __name__ == "__main__":
    main()
