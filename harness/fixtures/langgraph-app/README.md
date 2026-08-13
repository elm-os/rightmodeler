# LangGraph fixture

This fixture contains a deterministic interacting-pair regression for confirmation tests.
The classify and lookup nodes each record a marker when the proxy substitutes their current
model. Either marker alone preserves the accepted terminal output. When both markers are
present, the answer node emits a fixed degraded result so dependency-aware delta debugging
must isolate `{classify, lookup}` as one minimal failing subset.

The markers do not influence routing or the normal answer prompt, and an answer-only swap
does not trigger the regression.
