# Replay: per-step and code-execution E2E

## Bounded opt-in replay

Replay is never part of the default offline benchmark path. Invoke it explicitly
with a positive `--max-cost-usd` cap:

The model ID below is an illustrative example; select it from the active provider's
live catalog.

```bash
uv run python scripts/replay.py \
  --normalized .rightmodeler/normalized/normalized-runs.json \
  --cases .rightmodeler/corpus/benchmark-cases.json \
  --candidate-model openai/gpt-4o-mini \
  --max-cost-usd 2.00 \
  --out .rightmodeler/input/candidate-results.json
```

The wrapper estimates every uncached case before making a provider call. It
refuses an over-cap projection, uses a stable JSON cache when supplied, and
records `projected_cost_usd`, `actual_cost_usd`, `remaining_cost_usd`, cache
counts, replay mode, and completion status in the shared candidate-results
bundle. A provider cost overrun or an interrupted run is marked
`budget_exhausted` and `partial`; the scorecard adds a failing replay-budget
gate so a partial replay cannot pass release evaluation.

The `--pipeline` map controls routing. Steps marked `single_shot` use
`replay_step.py`; steps marked `e2e` require `--codebase`, `--run-command`, and
an explicit `--e2e-cost-per-case`. E2E processes must print authoritative
`cost_usd` in a JSON output line. If they do not, the wrapper refuses to treat
the run as bounded.

Two replay modes. Pick per step based on `analyze.py`'s classification.

## Mode A — per-step isolated replay (`replay_step.py`)

For single-shot LLM steps only. Take the step's exact `{system_prompt, input_messages,
available_tools, params}` from `normalized.json`, send it to a candidate model through
the active replay provider, and return the candidate output for the judge to compare
against the recorded `output_text`. Cheap, fast, parallelizable.

- Set `temperature=0` and a fixed `seed`. Know the limits: temp=0 makes token _selection_
  deterministic but GPU float non-associativity / MoE routing still drift — expect
  ~95–99% reproducibility, not bit-exact. For important steps, run N times and compare
  the distribution, not one sample.
- If the step had `available_tools`, keep them in the request and compare the tool call
  the candidate _chooses_ (name + args) — a single-shot tool-selection step is still
  legitimately single-shot as long as the tool isn't executed here.

## Mode B — code-execution E2E replay (`run_pipeline.py`)

For multi-step / tool-calling / looping steps, and to confirm any shortlisted swap
doesn't cascade. We re-run the user's **real pipeline code** with only the LLM swapped,
so tools actually fire and loops actually run. This is the "watch out for cascading
failures" box.

### 1. Model injection (no user-code edits)

Preference order:

1. **LiteLLM proxy (default, most robust).** Stand up a local OpenAI-compatible gateway
   that maps the model name the code asks for → a candidate on the active provider,
   and point the app at it. This is an illustrative OpenRouter-backed mapping; both
   `model` syntax and `api_base` must follow the active provider:
   ```yaml
   model_list:
     - model_name: baseline-model # illustrative name the code requests
       litellm_params:
         model: openrouter/openai/gpt-5.5-mini # illustrative candidate
         api_base: os.environ/RIGHTMODELER_REPLAY_BASE_URL
         api_key: os.environ/RIGHTMODELER_REPLAY_API_KEY
     - model_name: "*"
       litellm_params: { model: "openrouter/*" }
   ```
   `litellm --config config.yaml` then `OPENAI_BASE_URL=http://localhost:4000`. Central
   swap point + free request logging for trajectory capture. A LiteLLM proxy can also
   be the replay provider itself: select `RIGHTMODELER_PROVIDER=litellm`, point
   `LITELLM_PROXY_API_BASE` at its root, and use its public catalog aliases instead of
   running a second proxy.
2. **Env base_url redirect** when code uses the default OpenAI client and doesn't
   hard-code `base_url`. `run_pipeline.py` sets `OPENAI_BASE_URL` and `OPENAI_API_KEY`
   from the active provider before launch. Only the `litellm` route also sets
   `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`; its shim imports
   `langchain_anthropic` and relies on the Anthropic SDK to read those variables and
   append `/v1/messages`. OpenRouter and Vercel AI Gateway are not wired into
   Anthropic clients by this script.
3. **Monkeypatch** when the model _string_ must change or the client hard-codes base_url:
   patch `langchain_openai.ChatOpenAI.__init__` / `langchain_anthropic.ChatAnthropic` /
   `langchain.chat_models.init_chat_model` / `openai.OpenAI` before importing user code.
   `init_chat_model(configurable_fields="any", config_prefix=...)` is the clean hook when
   the code already uses it — override model per-invoke via `config={"configurable": {...}}`.

### 2. Faithful replay

- **Seed from the recorded task input** (initial user message / graph input), then let the
  agent loop live — do NOT feed back the recorded assistant/tool turns; we want the cheap
  model's _own_ trajectory from the same start.
- **Tool policy (per tool):**
  - _Mock from trace_ for side-effecting / non-deterministic / expensive tools (writes,
    payments, emails, time, RNG). Return the recorded output for a matching call. Caveat:
    if the cheap model calls with _different args_, there's no recorded answer → fall back
    to live or fuzzy-match, and note that mock-replay mainly measures "does it pick the
    same calls."
  - _Live execution_ for read-only / idempotent tools (search, pure reads, math) when you
    want a true end-to-end success signal. Must be sandboxed (below).
  - Default hybrid: mock destructive tools, run read-only live.
- **Freeze non-model HTTP** with `vcrpy` (or `respx` for httpx clients): record the
  expensive run's tool/HTTP calls to cassettes, replay them during the cheap run so only
  the active provider's model endpoint stays live. Match on method+URL+body; scrub auth
  headers.

### 3. Safe execution (sandbox)

The agent runs shell/file/network tools — treat as untrusted. Local default:
**ephemeral `git worktree` + fresh venv**, ideally inside Docker.

```bash
git worktree add --detach /tmp/cm-replay-$RUN $(git rev-parse HEAD)
python3 -m venv /tmp/cm-replay-$RUN/.venv
# install the repo's deps, run the patched entrypoint inside the worktree
git worktree remove /tmp/cm-replay-$RUN   # always clean up
```

Worktrees isolate _files_, not runtime — they don't stop port/DB/secret clobbering or
real network calls. So also: restrict egress to the active replay provider + required
endpoints, inject
throwaway secrets, and for arbitrary generated code escalate to Docker/gVisor or an E2B/
Modal microVM. Run each recorded task in its own sandbox for clean parallelism.

### 4. Entrypoint discovery

In priority order:

1. `langgraph.json` → `graphs` map `"name": "./path/graph.py:graph"` → import the compiled
   `StateGraph` and `.invoke(input)`.
2. `pyproject.toml [project.scripts]` / `console_scripts`.
3. `__main__.py` / `if __name__ == "__main__"` / a `main()`.
4. README / Makefile run command.
5. Raw-SDK: grep for `chat.completions.create`, `messages.create`, `create_react_agent`,
   `init_chat_model` to find the callable + input signature.
   Prefer importing the object and invoking in-process (lets you patch the model).

### 5. Trajectory comparison

Compare original vs cheap run on three axes: **tool-call sequence** (ordered/unordered
set of `(name, args)`), **step/loop count + cost delta**, **final output**. Use
`agentevals` trajectory-match (deterministic, for tool-selection regressions) + a
trajectory LLM-judge (for valid-but-different paths and final-answer quality). Aggregate
over N runs — majority trajectory + score distribution — because of determinism limits.

Sources: active-provider compatibility docs in [providers/](providers/), LiteLLM
proxy/wildcard routing, vcrpy/respx, git worktrees, LangGraph
application-structure/langgraph.json, agentevals/OpenEvals.
