# DSPy harness

## Live docs first

- [DSPy language models](https://dspy.ai/learn/programming/language_models/)
- [DSPy modules](https://dspy.ai/learn/programming/modules/)
- [DSPy API](https://dspy.ai/api/)

Fetch these pages before acting and check the installed DSPy version. DSPy delegates many provider
transport options to LiteLLM.

## Where the model id is bound

Bind the ID in `dspy.LM("provider/model")`, then install it with `dspy.configure(lm=lm)` or a
scoped `dspy.context(lm=lm)`. A module may also own or receive a distinct LM.

Prefer a scoped context around the single program invocation so unrelated modules are unchanged.
Verify `lm.history` and the persisted execution identify the candidate.

## Correlation forwarding

DSPy does not turn module inputs, callbacks, or `rollout_id` into provider headers. Pass
`extra_headers={...}` in `dspy.LM(...)`; DSPy forwards this transport option through LiteLLM. Use
a custom `BaseLM` wrapper if the values must change between calls made by one module.

Send `x-rm-step` and a fresh `x-rm-call` per logical LM request. Do not use `rollout_id` as the
call ID: it controls caching and sampling rather than HTTP correlation.

## Base URL override

Use `OPENAI_BASE_URL` as the harness variable and pass it explicitly as
`dspy.LM("openai/model", api_base=os.environ["OPENAI_BASE_URL"], ...)`. DSPy documents `api_base`
for OpenAI-compatible endpoints; it does not promise a universal framework-level base variable.

Provider-specific models may use other variables. A saved LM with a literal endpoint is pinned.

## Side-effect mocking

For `dspy.ReAct` or custom programs, replace tool callables with trace-backed functions before
constructing the module. Preserve signatures, match name plus canonical arguments and occurrence,
and return the recorded value.

Fail on unknown, mismatched, duplicate, or missing calls. Disable or isolate the DSPy cache for
the harness case so a cached prediction cannot bypass the expected tool sequence.

## Entry point

The natural case invocation is the program/module call, such as `program(question=...)`; a custom
`dspy.Module` executes its `forward` method. Wrap one call in a command only when process
isolation is needed.

Emit prediction fields, LM history for the case, tool events, and terminal output as JSON.

## Coupling detection

Inspect custom `forward` control flow, composed predictors, `ReAct` iterations, retrievers, and
prediction fields passed to later modules. A multi-module program is not single-shot merely
because each predictor is declarative.

Confirm coupled programs end to end. Compare LM/module order, tools, prediction fields, final
output, and metrics. A changed module count or branch fails the case.
