# Reconstructing a corpus when there are no usable traces

Most production apps don't keep agent traces — but they usually **persist LLM
outputs in their database** (summaries, analyses, classifications, drafts) next to
the input they were computed from. That stored data is a legitimate reference
corpus: the input column is the step input, the stored output is the accepted
output, and the prompt lives in the app's source code. Rebuild the corpus by hand
and feed it straight into `orchestrate.py`, skipping `ingest.py`.

## Recipe

1. **Locate the pairs.** Find tables/collections holding both the raw input (e.g. a
   call transcript) and the model-generated columns (summary, persona, topics…).
   Each generated column is one **task family**; each row is one **case**.
2. **Recover the exact prompts.** Copy the system/user prompt templates verbatim
   from the app source (the module that makes the LLM call). Do not paraphrase —
   the replay must send what production sends.
3. **Resolve model IDs.** Match logged names against the active provider's live
   catalog. Hosted routes generally use `creator/model` IDs; LiteLLM may expose
   operator-defined aliases. `model_info()` resolves exact catalog IDs and supported
   unambiguous variants, but bake the provider's catalog ID into the corpus.
4. **Pick N cases per family.** ~8 diverse cases per family is enough to run the
   per-family pass-rate bar in `report.py`; one case proves nothing.
5. **Emit `normalized.json` and `pipeline.json`** (schemas below), then run
   `orchestrate.py <pipeline> --normalized <normalized> ...` as usual.

Warn the user if the stored outputs came from a cheap or mixed model — the
baseline is only as good as the model that produced it.

## Hand-built `normalized.json`

Only the fields the replay and judge actually read are required (full schema in
[trace-formats.md](trace-formats.md)). One step per (family × case); set `case_id`
so `analyze.py` doesn't mistake repeated step names for a loop:

```json
{
  "trace_id": "corpus-<app>-<date>",
  "source_format": "reconstructed",
  "steps": [
    {
      "step_id": "summary-00",
      "case_id": "call-8f3a",
      "order": 0,
      "kind": "llm",
      "name": "summary",
      "model": "<catalog-model-id>",
      "system_prompt": "<verbatim system prompt from app source>",
      "input_messages": [{ "role": "user", "content": "<the stored input>" }],
      "output_text": "<the stored accepted output>",
      "success": {
        "status": "ok",
        "accepted": true,
        "source_signal": "stored_output"
      }
    }
  ]
}
```

## Hand-built `pipeline.json`

`orchestrate.py` reads these fields per step:

```json
{
  "steps": [
    {
      "step_id": "summary-00",
      "name": "summary",
      "family": "summary",
      "model": "<catalog-model-id>",
      "replay_mode": "single_shot",
      "evaluator": "reference",
      "risk": "normal"
    }
  ]
}
```

Use the same `family` string for all cases of a task so the report can aggregate
pass-rates across cases; the per-family table (not per-step wins) is the decision
table.
