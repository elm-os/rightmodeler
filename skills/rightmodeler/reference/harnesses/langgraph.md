# LangGraph harness

## Live docs first

- [LangGraph graphs API](https://docs.langchain.com/oss/python/langgraph/graph-api)
- [LangGraph runtime configuration](https://docs.langchain.com/langsmith/configurable-headers)
- [OpenAI Python SDK](https://github.com/openai/openai-python)

Fetch these pages before acting. For this repository's fixture, the implementation below is the
ground truth when generic LangGraph examples differ.

## Where the model id is bound

The fixture binds `CLASSIFY_MODEL`, `LOOKUP_MODEL`, and `ANSWER_MODEL` in `main.py`, then passes
the relevant constant as `model=` inside each node's `chat.completions.create(...)` call. Swap
policy keys are runtime node IDs: `classify`, `lookup`, and `answer`.

The Mode B proxy selects the candidate from the `x-rm-step` value and rewrites only the outbound
request body's model. `modebConfig.stepMap` maps canonical scanner IDs to those unique runtime
IDs. Verify the proxy attempt and execution identify the substituted model.

## Correlation forwarding

LangGraph does not add provider correlation headers. The fixture passes OpenAI Python
`extra_headers=call_headers(...)` on every SDK invocation. `call_headers` emits `x-rm-step` and a
fresh UUID in `x-rm-call`, plus run, case, and execution IDs.

The proxy fails closed with HTTP 400 and a lost record when either required header is absent, and
also rejects duplicate `x-rm-step` values. It never forwards those invalid requests. Keep one
`x-rm-call` across transport retries of the same logical call.

## Base URL override

The fixture constructs `OpenAI(base_url=os.environ["OPENAI_BASE_URL"], api_key=...)`. It honors
the override explicitly. Mode B sets `OPENAI_BASE_URL` to `http://127.0.0.1:8787/v1` inside the
container.

Do not replace this with a pinned provider URL. The configured application command must receive
the driver environment unchanged.

## Side-effect mocking

The fixture's `lookup_order` is a pure deterministic local function. It returns fixed JSON for
the selected order ID; this is not recorded-result playback. Keep it local for the fixture.

For a real side-effecting LangGraph node or tool, inject a trace-backed callable at graph build
time. Match tool name, canonical arguments, and occurrence; return the recorded result in the
same state update or tool-message shape. Fail on unknown, mismatched, duplicate, or missing
results. The fixture already fails loudly when the model selects an invalid tool.

## Entry point

The natural graph call is `build_graph().invoke(initial_state)`. The fixture exposes one case as:

`python3 /rightmodeler/app/main.py --case-json <case-file>`

The JSON requires string `caseId` and `input`; optional `headers` maps strings to strings. A valid
`modebConfig` is version `1`, uses that command with `{caseFile}`, and supplies its image, mount,
and canonical-to-runtime `stepMap`.

## Coupling detection

The fixture topology is `START -> classify -> lookup? -> answer -> END`. Classification controls
the branch, and lookup output becomes answer context. Therefore `classify` and `lookup` have
observable downstream consumers.

A classify-only or lookup-only substitution preserves the fixture result, while substituting
both forces the recorded interaction failure. Confirmation isolates `classify` plus `lookup`,
with `classify` as the earliest cascade seed. Compare node sequence, tool behavior, final output,
and checks; never drop a changed route.
