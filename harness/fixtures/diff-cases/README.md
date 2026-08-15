# Swap diff fixtures

This standalone fixture covers the three supported model replacement forms:
call-site string literals, model configuration values, and TypeScript and Python
constants referenced by call sites. It also contains a model mention in a
comment, a call site used by the stale-location test, and a deliberately
misformatted file used to prove that host formatting cannot rewrite untouched
lines.

The stale-location test scans `src/stale.ts`, then changes its enclosing function
before asking the diff builder to relocate the original step.
