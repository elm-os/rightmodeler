# Can a model do the reference audit?

- Status: `experiment, single run`
- Date: 2026-07-27
- Tool under test: `skills/rightmodeler/scripts/reference_audit.py` (retired; replaced by the
  TypeScript harness, see `harness/docs/Architecture.md`)

## Why this was run

The reference audit exists because rightmodeler has no ground truth. Its reference is the
accepted historical output of the incumbent model, so every downstream statistic really
estimates agreement with that key, and inherits each of its errors as if it were correct.
If the accepted outputs are wrong at some rate, no correction downstream beats that rate.

The audit is specified as human work. The question here was whether a model can do it
instead, and the honest way to answer that is to measure rather than assume.

## Method

Twenty-four realistic accepted outputs were written across the task families the analyzer
recognises: PR summary, SQL generation, test generation, bug fix, doc rewrite, support
draft, code review, and tool trajectory. Six carried a deliberately seeded defect of the
kind that reads fluently and survives casual review:

| Case            | Seeded defect                                                                     |
| --------------- | --------------------------------------------------------------------------------- |
| PR summary      | Direction reversed: diff reduces a TTL 900 to 60, summary claims an increase      |
| SQL             | `COUNT(*)` in a `WHERE` clause, which is invalid; belongs in `HAVING`             |
| Test generation | Task says "raises on insufficient funds"; test performs a successful withdrawal   |
| Doc rewrite     | Requirement says per-attempt timeout; doc says total across attempts              |
| Support draft   | Asserts an absolute deletion guarantee with no retention, unsupported by the task |
| Tool trajectory | Required order violated in the trace, and the output calls the usage correct      |

The sample was drawn with the audit tool itself, seeded and uniform, and the worksheet
carries only `case_id`, `task`, and `accepted_output`. Ground truth and the source corpus
were moved outside the directory either auditor could reach.

Two auditors reviewed the same worksheet independently, from **different model families**,
neither seeing the other's verdicts. Cross-family independence is the same requirement
`reference/judge.md` already places on the judge, for the same reason: two models from one
family can share a blind spot and agree confidently while both are wrong.

## Results

|                                          | Fable 5                 | GPT-5.6-Sol               |
| ---------------------------------------- | ----------------------- | ------------------------- |
| Defects caught                           | 6 of 7                  | 7 of 7                    |
| Missed                                   | 1                       | 0                         |
| False alarms on correct outputs          | 0                       | 0                         |
| Hedged (`ambiguous`) on a correct output | 0                       | 1                         |
| Precision                                | 100%                    | 100%                      |
| Recall                                   | 86% (95% CI 49% to 97%) | 100% (95% CI 65% to 100%) |

Inter-auditor agreement: 22 of 24 verdicts identical, raw agreement 92%, Cohen's kappa
**0.80**. That clears the `kappa >= 0.60` bar this repo's own target policy sets for a
calibrated judge, though note that policy governs the judge rather than the auditor.

## The finding that matters most

**The answer key was wrong, and one auditor caught it.**

The table above says seven defects. Six were seeded deliberately. The seventh was not.

Case `run-15` asked for a reply to a customer who "was double-charged 49.00 and wants a
refund". The accepted output said "I have issued a refund for it". The task establishes
that the customer _requested_ a refund; it never establishes that one was _issued_. The
output asserts an action that nothing supports, which is precisely the defect class
deliberately seeded into the support-draft case that was labelled bad. It was written
without noticing, and labelled correct.

GPT-5.6-Sol flagged it. Fable 5 passed it. Had the disagreement been scored against the
original key without reading the reasoning, the auditor that was right would have been
recorded as having a false-alarm rate, and the one that missed a real defect would have
scored perfectly.

This is the same recursive problem the reference audit exists to expose, reproduced one
level up: an evaluation is only as good as the key it is scored against, and the author of
a key is not a reliable judge of it. It is also a concrete argument for two auditors from
different families rather than one, because the disagreement carried the signal.

## What this supports

A model auditor is a defensible substitute for a human **first pass** at this scale. Both
auditors found every deliberately seeded defect, neither raised a false alarm against a
correct output, and the one hedge (whether `mean([])` should return `0.0`, a sentinel, or
raise) is a genuinely debatable design call rather than an error.

## What this does not support

- **Twenty-four cases is small.** A perfect 7 of 7 still carries a 95% confidence interval
  on recall from 65% to 100%. This is evidence, not proof.
- **The defects were written by the same person who scored them.** They were chosen to be
  representative and catchable-but-not-obvious, which is not the same as being drawn from
  the distribution of real reference rot. The Princeton reliability authors discarded 24 of
  50 tau-bench airline tasks for flawed ground truth, a far messier distribution than the
  clean 25% used here.
- **Two families do not fully retire the correlated-error risk.** Both auditors are
  frontier models, and the accepted outputs they reviewed were themselves written to look
  like frontier-model output. A defect that every frontier model shares would pass both.
  The literature ceiling applies: an auditor no stronger than what produced the output
  cannot fully substitute for an independent label.
- **Nothing here was measured on a real customer corpus.** This repository contains only
  smoke fixtures, because customer traces are customer-owned and stay local by design. The
  rate that matters is the one measured on the corpus actually being used as a key.

## Recommended practice

Run the audit with two auditors from different model families. Treat agreement as a first
pass and **read every disagreement**, because that is where both the auditor errors and the
answer-key errors surface. Record which auditor produced a verdict, since a model verdict
and a human verdict do not carry the same weight, and report the resulting disagreement
rate as a stated ceiling on every other number in the report.
