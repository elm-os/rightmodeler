# Eval Engine Spike

## Purpose & Boundary

The offline deterministic evaluator is built in
`apps/pipeline/src/pipeline/evaluate.py`. It reads accepted `final_output` values
from historical run bundles, emits recommendation objects in the report contract
shape, and stays fully offline.

The OpenRouter-backed replay path described here is design only. It is not wired
into the default pipeline, `smoke`, `pnpm check`, or CI. This replay interface is
the future path for PRD section 9.2 reference-based comparison: candidate model
outputs are compared with accepted historical outputs before any cheaper model is
recommended.

## OpenRouter Access

Future replay code should use the OpenRouter REST base URL
`https://openrouter.ai/api/v1`. Authentication must come only from the
`OPENROUTER_API_KEY` environment variable, loaded from the process environment
or from a local gitignored `.env` file. `.env.example` documents the variable
name with an empty value.

The API key is never hardcoded, never logged, and never committed. Free-tier
OpenRouter models with a `:free` suffix are acceptable for prototyping, but
benchmarks should account for their lower rate limits and availability.

## Candidate Model Config Format

Replay should take a user-supplied JSON list of candidate models. Each entry
should include the fields needed for PRD section 10 candidate selection:

```json
[
  {
    "id": "provider/model",
    "provider": "provider",
    "cost_per_1k_input": 0.0,
    "cost_per_1k_output": 0.0,
    "context_window": 0,
    "supports_tools": false,
    "supports_structured_output": false
  }
]
```

The engine should filter candidates by customer allowlist, context window,
tool-use support, structured-output support, and lower expected cost than the
current model.

## Sample Selection

For each task family, select representative historical runs that have an
accepted `final_output`. Samples should be stratified toward families the
deterministic evaluator marked `deterministic` versus `abstain`, because those
families need different evidence:

- `deterministic` families should replay enough examples to confirm the cheaper
  model preserves the same machine-checkable property.
- `abstain` families should replay accepted outputs for reference-based or
  calibrated judge comparison before any recommendation can move above low
  confidence.

The number of examples per confidence band remains open, matching PRD section 17.

## Reference-Based Scoring

For each selected run, replay the original `prompt` and `system_prompt` against
each candidate model. Score the candidate output against the accepted
historical `final_output` and any human `notes`.

Scoring order:

1. Run deterministic checks first, reusing checks such as `valid_json` and
   `non_empty_output`, plus any future per-family output schema.
2. If deterministic signal is insufficient, run a reference-guided judge that
   compares the candidate output with the accepted historical output.
3. For position-bias mitigation from PRD section 9.4, swap output order and
   repeat important judge runs. Keep only order-consistent judgments.

The system must not judge a candidate in isolation when an accepted reference
exists.

## Hermetic Default & Where Replay Runs

Replay must sit behind an explicit future flag, such as
`pipeline evaluate --replay` or `pipeline evaluate --online`. The default is
off.

The default pipeline, `smoke`, `pnpm check`, and CI must remain fully offline.
CI should run only the deterministic evaluator and schema/report validation.

## Cost, Non-Determinism, Secret Handling

Replay should cap total spend before requests are sent. Responses should be
cached by a hash of `(model, prompt, system_prompt)` so repeated analysis does
not spend twice on identical work.

Requests should use temperature `0` and record seeds where providers support
them, but the engine must still treat model outputs as non-deterministic. For
important recommendations, repeat runs and score the distribution.

Secrets must only enter through environment variables. Do not log request
headers. Do not persist response payloads that could echo secrets.

## Open Questions

These PRD section 17 questions remain open:

- Which model providers should be included in the initial candidate set?
- How many examples are required before a recommendation can be medium or high
  confidence?
- Should high-risk task families require explicit human approval?

## Interface Sketch

Future code could live in `apps/pipeline/src/pipeline/replay.py`, separate from
the offline evaluator:

```python
class OpenRouterClient:
    def __init__(self, base_url, api_key_from_env):
        ...


def replay_family(runs, candidates):
    """Return reference scores for candidate models.

    Future only: not built in this spike.
    """
```

`OpenRouterClient` should read `OPENROUTER_API_KEY` from the environment at
runtime. `replay_family(runs, candidates) -> reference_scores` should return
per-candidate scores, evidence type, confidence inputs, cost observations, and
any abstain reasons. This interface is future work and is not implemented in
this spike.
