# Research that can augment the rightmodeler methodology

- Status: `research note`
- Date: 2026-07-26
- Method: two parallel multi-agent literature sweeps across eleven research lenses, with
  adversarial citation verification; then a full-text read of the five finalists, each
  auditing the claims made about it; then an independent second opinion that re-read all
  five papers and re-verified every line-level code claim. 55 papers survived citation
  verification. The five below were selected for institutional credibility, recency, and
  direct mapping onto a named component of this repo.

## Read this part first

The five papers were selected from their abstracts. Reading them end to end invalidated
roughly half of the prescriptions in the first draft of this note. **The diagnoses held;
the fixes did not.** Four of these five abstracts overstate their own bodies.

That is itself the most useful finding here, and it is the reason this note now records
what each paper does **not** support alongside what it does.

| #   | Paper                                            | Institution             | What actually transfers                                                  |
| --- | ------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------ |
| 1   | Towards a Science of AI Agent Reliability        | Princeton               | Most. It proves nothing, so it assumes nothing it can violate            |
| 2   | AutoEval Done Right                              | UC Berkeley             | Its multiplicity appendix, not its headline estimator                    |
| 3   | The Illusion of Diminishing Returns              | ICLR 2026               | A mechanism and a set of design corrections, not statistics              |
| 4   | Conformal Alignment                              | Harvard, Penn, UChicago | The only guarantee that survives our data structure, once we have labels |
| 5   | Efficient Evaluation with Statistical Guarantees | Stanford                | Least. Its operating regime is the complement of ours                    |

The ranking is inverted from the first draft. The least statistically impressive paper
transfers most, and the most rigorous transfers least.

## The problem none of these papers solve

rightmodeler has no ground truth. Its reference is the accepted historical output of the
incumbent model. Substituting that for a correctness label changes every estimand from
`E[quality]` to `E[agreement-with-incumbent]`, and each of these estimators will then
faithfully, unbiasedly, and with a valid interval estimate the wrong quantity, inheriting
every incumbent error as correct. This is not an exchangeability problem and no amount of
sampling discipline fixes it.

The Princeton authors are the only ones who measured what a bad answer key costs: they
discarded 24 of 50 tau-bench airline tasks for flawed ground truth and ambiguous
specifications, and reported that predictability and safety improved almost universally
on the clean 26-task subset, because an agent that confidently solves a task yet is
penalised by an incorrect answer key is unjustly judged overconfident. Consistency and
robustness did not move reliably.

The actionable corollary: the metrics **robust** to a bad key (consistency, robustness)
are the ones we can safely adopt. The **fragile** ones (predictability, safety) are the
ones we should not. And auditing a uniform random sample of our own accepted outputs is
cheaper than any statistical machinery in this set, and calibrates the ceiling on all of
it.

---

## 1. Towards a Science of AI Agent Reliability

- Rabanser, Kapoor, Kirgis, Liu, Utpala, Narayanan
- Princeton University, Holistic Agent Leaderboard group
- ICML 2026. arXiv:2602.16666, v1 18 Feb 2026, v3 2 Jun 2026
- https://arxiv.org/abs/2602.16666

**What it delivers.** Twelve metrics decomposing agent reliability along consistency,
robustness, predictability, and safety, evaluated across fifteen models. Recent capability
gains yielded only small reliability improvements. Mean quality and reliability come
apart, so a single-sample pass rate cannot see the failure mode.

**What it does not deliver.** No theorem, bound, confidence interval, significance test,
or multiple-comparison correction. The only reported uncertainty is one standard error on
figure error bars. The authors call the contribution "empirical-synthetic rather than
axiomatic" and "a working operationalization, not a redefinition", and explicitly decline
the classical reliability formula because its assumptions do not hold. Any consistency
floor we add is **our** invention and must be validated against our own frozen labels,
not attributed to this paper.

**What we build.** Stop discarding the N-sample distribution. `C_res`, the coefficient of
variation over cost and latency across K runs, is nearly free from data already collected
and needs no answer key. `C_out` is real but carries a finite-K upward bias: it uses the
biased MLE Bernoulli variance whose expectation is `p(1-p)(K-1)/K`, so at K=5 the variance
term is 80% of truth and a floor built on it fails to block precisely when it should. At
K=1 it is identically 1.0, a silent always-pass gate.

**Three corrections to the first draft.** `replay_step.py` already returns the sample
list; the discard points are `replay.py::_normalize_result` and
`orchestrate.py::evaluate_candidate`. `pass@k` is not one of the twelve metrics and moves
opposite to consistency, so reporting it as a consistency gate would reward exactly the
behaviour the gate should catch. And `run_pipeline.py` has no mock layer to jitter for the
robustness axis: the word `mock` appears zero times in that file.

**Do not import its safety judge.** It is an unvalidated LLM judging pass with no
inter-rater agreement, no position swap, and no third-family requirement. Adopting it
would be a regression against our own `judge.md`.

**Smaller models are often more consistent than larger ones.** Calibration, robustness,
and safety generally improve with model size, but consistency often shows the inverse
pattern, because larger models' multiple solution paths increase run-to-run variability.
For a downgrade-recommendation product this cuts in our favour, and argues for a relative
rather than absolute consistency comparison.

## 2. AutoEval Done Right: Using Synthetic Data for Model Evaluation

- Boyeau, Angelopoulos, Li, Yosef, Malik, Jordan
- UC Berkeley and Weizmann Institute
- ICML 2025, PMLR v267 pp. 5276-5290 (arXiv:2403.07008)
- https://proceedings.mlr.press/v267/boyeau25a.html

**The headline number is wrong for our configuration.** With an LLM autorater the paper
reports a 20-25% effective-sample-size improvement, and 20-35% across judges tested. The
roughly 50% figure comes from two settings with **no LLM autorater**: ImageNet accuracy
using each model's own softmax, and ProteinGym using VESPA. The "50% with gpt-4" sentence
survives only in the superseded arXiv abstract that the camera-ready deleted. At n=10,000
the gain falls to a 1.29x efficiency ratio.

**PPI++ is void for us as currently instrumented.** It requires both datasets to be i.i.d.
and explicitly declines non-i.i.d. extensions, while our cases are dependent steps inside
trajectories. It requires the labeled set to be sampled uniformly at random from the
unlabeled pool, while our frozen labels are assigned to cases a human chose to adjudicate,
which is the named failure mode verbatim. And our judge is selected by correlation with
the same human labels that would form the bias-correction term, so the correction is not
mean-zero.

**The failure is not conservative.** Table S1 measures coverage against a 0.90 target
under non-random labeling as n grows: 0.5044, 0.3780, 0.2444, 0.1992, 0.1692, 0.1572 at
n = 50, 100, 200, 300, 400, 500. The interval tightens around a biased centre, so the
estimate becomes **more confidently wrong as the corpus grows**. This inverts the naive
intuition that bad sampling yields honestly wide intervals.

**Plain PPI is a trap.** In the protein experiment, PPI with lambda=1 performed worse than
simply using the human labels. Any implementation must power-tune lambda. And the real
argument for PPI++ is weaker than the pitch: with a poor annotator it falls back to
lambda=0 and performs at least as well as the classical approach. That is a statement
about not being harmed, not about being helped.

**What we actually build, and it was missing from the first draft entirely.** Appendix C.2
ranks models using confidence intervals after Bonferroni correction, treating overlapping
intervals as ties, with a simultaneous chi-squared set as the alternative. We apply no
correction across the many (family, candidate) pairs a sweep fans out, so a 0.90 bar gets
cleared by chance somewhere in the sweep at a rate nobody reports. This needs no PPI++,
no new data, and violates no assumption we hold.

Bonferroni is the right tool here for a reason worth stating: the deliverable is
simultaneous **intervals**, and only Bonferroni yields them. Holm dominates for testing
but produces no intervals; Benjamini-Hochberg controls a false discovery rate rather than
simultaneous coverage and is reserved for the conformal layer below. Correlation across
candidates does not threaten validity, since Bonferroni holds under arbitrary dependence
and positive dependence only makes it more conservative.

**The revival recipe.** Table S1's reweighted column restores 0.91-0.93 coverage under the
same non-random labeling. Known selection probabilities are not only what kills PPI++
today, they are what would bring it back.

## 3. The Illusion of Diminishing Returns: Measuring Long Horizon Execution in LLMs

- Sinha, Arun, Goel, Staab, Geiping
- MPI for Intelligent Systems and ELLIS Institute Tubingen, Stuttgart, Southampton, Cambridge
- ICLR 2026. arXiv:2509.09677, v3 13 Mar 2026
- https://arxiv.org/abs/2509.09677

**Hyperbolic, not exponential.** Proposition 1 gives `H_s(p) = ceil(ln s / ln p)`, and the
paper states directly that horizon length grows **hyperbolically** with step accuracy. It
reserves "exponential" for horizon growth over calendar time, whose point is that a
diminishing schedule of accuracy gains can sustain it. The first draft inverted the thesis.

**Self-conditioning, sharpened.** Per-step accuracy degrades as steps accumulate because
the model's own earlier errors sit in its context. Scaling model size **increases**
self-conditioning, even for frontier non-thinking models, while long-context degradation
is a separate co-occurring effect largely solved by very large models. The mitigation is
specific to RL-trained thinking models, which showed none. Chain-of-thought prompting does
not fix it, and self-verification prompting does not either. Context trimming does help.

**What this means for Mode A.** Our single-shot replay feeds the candidate the incumbent
model's clean prefix, so it structurally cannot observe self-conditioning. Mode A is
optimistic by construction, and it is our cheapest and therefore most-used measurement
path. The paper's healed-history arm is definitionally Mode A and its un-healed arm is
Mode B, so running a sampled subset through both gives a per-customer empirical estimate
of exactly that optimism, with no projection required.

**The projection cannot gate.** `p^H` rests on constant per-step accuracy, independence,
and no self-correction. The paper's own experiments refute the first two, and it does not
model the third. So it is optimistic under self-conditioning and pessimistic under
self-correction, and bounds nothing in either direction. Statistically it is also
indefensible at our scale: at `p = 0.92` with n = 10, the 95% interval on `p^20` spans
roughly [0.003, 1.0]. The diagnosis is still worth publishing (0.92 per step over 20 steps
is roughly 19% end to end, and our own 0.90 floor implies roughly 12%), but as a labelled
diagnostic with an interval, never as a gate.

**Length is the wrong trigger.** Self-conditioning requires the model's own prior output
in context, so the mechanism-correct predicate is prefix provenance, not step count. A
30-step family of independent classifications has zero exposure; a 3-step chained family
has full exposure. There is also no transferable numeric horizon: the paper finds no turn
complexity that is consistently worst across model families.

**The failure locus is state tracking.** Models are near-perfect on stateless
retrieval-only and addition-only tasks over long horizons; degradation appears only once
state must be carried. That is a better classification axis for `analyze.py` than its
current tool and loop heuristics.

**Free remediation priors.** Because the paper tested them and they failed: self-
verification prompting, chain-of-thought prompting, and majority-vote parallel sampling.
The last matters here, because it means the value of `runs > 1` is retaining the
distribution for variance estimation, not adding majority voting.

## 4. Conformal Alignment: Knowing When to Trust Foundation Models with Guarantees

- Yu Gui (UChicago), Ying Jin (Harvard), Zhimei Ren (Penn)
- NeurIPS 2024 (arXiv:2405.10301)
- https://proceedings.neurips.cc/paper_files/paper/2024/hash/870ccde24673d3970a680bb48496ed63-Abstract-Conference.html

**This is the one guarantee that survives our data structure, and that is the strongest
positive finding in the whole review.** Remark 3.2 admits calibration sets drawn from a
set of samples without replacement, which is exactly a uniformly random split of our
immutable content-addressed corpus. And Theorem 3.1 is stated conditional on the other
test units, so arbitrary dependence **among** test units is permitted: neither the
orchestrator fan-out nor trajectory correlation breaks it.

**What it cannot do.** It cannot deliver "zero unsafe substitutions, guaranteed". The
theorem is stated for alpha in (0,1); alpha = 0 is excluded by construction. FDR is an
expectation over data randomness, and the paper gives no high-probability bound on the
realised false discovery proportion of a single run. The strongest available claim is that
at most alpha of certified substitutions are expected to be unsafe, within this snapshot,
conditional on trusting the alignment proxy. Keep the existing hard count as a separate,
retrospective check; the two can coexist.

**The binding constraint is labelled volume, not an assumption we cannot meet.** The
smallest attainable conformal p-value is `1/(|D_cal|+1)`, so alpha = 0.05 requires
`|D_cal| >= 19` even to certify everything, and `>= 39` to certify half a batch. The
paper's experiments use 100, 500, and 2000, and its framing is that a few hundred good
samples suffice. The "500 per candidate" figure in the first draft was our engineering
inference, not a paper recommendation, and it overpriced the entry point by roughly an
order of magnitude. Thirty-nine uniformly sampled labels is a product afternoon.

**Two design constraints.** The unit is one replayed case under one fixed candidate, not
a (family, candidate) pair: the paper views the model as given and fixed, so N candidates
need N runs with N calibration sets. And every alignment-prediction feature that carried
weight is a dispersion statistic over multiple generations per input, so this has a hard
dependency on retaining the N-sample distribution. Theorem 3.1 also requires no ties in
predicted scores, so a predictor emitting our discrete ordinal verdict is inadmissible.

**Power can be exactly zero, and that is a correct result.** For a weak model at
alpha=0.05 the paper reports nearly no discoveries. A candidate for which the procedure
certifies nothing must be distinguished in our report from a candidate measured as unsafe,
or it will read as a broken pipeline.

**Table 1 is the cleanest illustration of proxy-metric failure, and it mirrors our
reference-comparison rung exactly.** Reference "KitKat", generated "Kit Kat Klub", scored
misaligned by ROUGE-L yet certified by the procedure. A substantively correct answer
labelled unsafe by the reference metric, entirely because of string comparison against an
accepted output.

**Model self-confidence is worthless as an abstention signal.** Self-evaluation was among
the least informative features by both ROC and Shapley analysis, and thresholding it fails
to control FDR because it is overconfident. The Princeton paper independently found
selective prediction on tau-bench indistinguishable from random. Two independent papers,
one conclusion: never add self-reported confidence as an abstention signal.

## 5. Efficient Evaluation of LLM Performance with Statistical Guarantees

- Skyler Wu, Yash Nair, Emmanuel J. Candes
- Stanford University, Department of Statistics
- arXiv:2601.20251, v1 28 Jan 2026, v3 8 May 2026
- https://arxiv.org/abs/2601.20251

**Ranked last, and not because it is the weakest paper.** It is arguably the most rigorous
of the five. Its operating regime is simply the complement of ours: FAQ exists to avoid
querying the whole bank, and we query the whole bank.

**The estimand does not match ours.** Theorem 3.1 gives asymptotically valid Wald
intervals for **finite-bank** accuracy, the exact pass rate on the specific enumerated
corpus queried, resting on a martingale CLT under assumptions A.1 to A.3. The authors
explicitly refuse the superpopulation estimand and distinguish themselves from the PPI
line of work on exactly that point. Every one of our gates is a forward-looking claim that
a substitution will be safe on future traffic, which a finite-bank interval cannot support
at any budget. And when the corpus is replayed in full, the interval has width zero.

**Two of the three proposed phases must not ship.** Gating on `ci_low >= threshold` is
numerically unpassable at our scale: a perfect 20/20 has a two-sided 95% Wilson lower
bound of 0.839 against a 0.90 floor, and an observed rate of exactly 0.90 never clears the
gate at any n. Shipping it converts the quality gate into a permanent fail that looks like
rigor and lands as an outage. Separately, ordering replay cases by expected interval
narrowing is a deterministic without-replacement scheme that makes the selection
probability degenerate and violates the positivity requirement that keeps the
inverse-probability weights bounded; the paper's footnote 3 states that support for its
assumptions requires sampling **with** replacement and points at an appendix discussing
how ad-hoc without-replacement variants fail to yield valid coverage.

**Its real contribution to us is vocabulary, and it is worth more than any code change
from this paper.** Our `_ratio_metric` emits a bare numerator over denominator with no
statement of what population it describes. When the corpus is replayed in full, that
number is an exact census: zero sampling error, full generalization risk. Labelling it
that way is both more truthful and cheaper than dressing it in an interval. The caveat to
carry with it: census covers case selection only. Judge noise and one-draw-per-case
sampling noise remain even at full coverage.

**The headline multiple is 1.8-2.4x, not 5x.** The 5.01x figure is against uniform
sampling at one budget on one suite with a fully observed 2,200-model matrix. Against the
strongest baseline it is 1.8-2.4x, and the authors deliberately report baselines after
post-hoc selection, which favours the baselines. A cold-start recipe does exist (transfer
question factors by nearest-neighbour over embeddings) and yields 1.32x, correcting the
first draft's claim that day one was impossible, but it presumes hundreds of held-out
queryable models to tune the policy.

## Runners-up worth reading

1. **The Partial Testimony of Logs: Evaluation of Language Model Generation under
   Confounded Model Choice.** Jin and Syrgkanis, Stanford. arXiv:2605.01311, May 2026.
   The one that questions the premise. It formalises three sources: OBS (confounded
   observational logs), EXP (randomized experiments), SIM (offline simulators that replay
   candidate models on cached contexts). Its identification theorem says EXP and SIM
   together recover causal model values, and the observational log enters afterward to
   reduce estimation error rather than to make the comparison valid. We are OBS plus SIM
   with no randomized arm, so our recommendations are variance-reduced but not identified.
   The honest fix that does not violate the not-a-router non-goal: detect an EXP arm that
   many customer traces already contain (canary, A/B, rollout traffic, an experiment tag),
   and mark the claim `causal` or `associational` accordingly.
2. **Trust or Escalate: LLM Judges with Provable Guarantees for Human Agreement.**
   Jung, Brahman, Choi. UW and AI2. ICLR 2025 Oral, arXiv:2407.18370. Selective evaluation
   with a coverage guarantee, plus a cheap-judge-then-escalate ladder that preserves it.
   Guarantees are on pairwise preference agreement, so mapping to a three-level ordinal
   verdict is not free. See also "LLMs Judging LLMs: A Simplex Perspective" (AISTATS 2026),
   which proves an identifiability phase transition: binary scoring is recoverable from a
   merely consistent judge, three or more levels is not. That is a direct argument for
   demoting `minor_drift` to a non-gating annotation.
3. **Limits to scalable evaluation at the frontier: LLM as Judge won't beat twice the
   data.** arXiv:2410.13341. The ceiling on the whole judge-debiasing line: a judge no
   stronger than the evaluated model cannot beat twice the human data.
4. **Cutting LLM Evaluation Costs with SySRs.** ETH Zurich and MPI-IS, ICML 2026,
   arXiv:2606.07726. Fixed-budget best-arm identification exploiting paired correlated
   responses, identifying the best model using at most 35% of the model-by-query grid.
   Overlaps the adaptive-allocation story, which is why it is a runner-up.
5. **Why Do Multi-Agent LLM Systems Fail? (MAST)**, Berkeley, ICML 2025, arXiv:2503.13657,
   and **Which Agent Causes Task Failures and When?**, ICML 2025, arXiv:2505.00212.
   The strongest available attack on our earliest-sub-threshold cascade heuristic; the
   second ships step-level labels for measuring attribution accuracy.
6. **Establishing Best Practices for Building Rigorous Agentic Benchmarks.** UIUC,
   Stanford, Berkeley, Yale, Princeton, MIT. NeurIPS 2025 D&B, arXiv:2507.02825. Already
   cited in `docs/PRD.md` section 18 but not implemented. Its checklist is the missing
   construct-validity audit for our deterministic-verifier rung.

## Caveat on the evidence base

Three of the five papers have no agentic evidence at all. AutoEval evaluates ImageNet,
protein fitness, and single-turn Chatbot Arena; FAQ evaluates single-turn multiple-choice
and short-answer; Conformal Alignment evaluates one prompt, one output, one static
reference. The Princeton paper is genuinely agentic but never evaluates model
substitution. The Illusion paper is multi-turn but principally on a synthetic running-sum
task. Nothing in this set was validated on the exact problem rightmodeler solves.

## Incidental findings

`docs/PRD.md` section 8 says task family labels are invented automatically.
`skills/rightmodeler/scripts/analyze.py` (retired; replaced by the TypeScript harness, see
`harness/docs/Architecture.md`) implemented eight hard-coded regexes plus a
`general` catch-all, with no override at any layer. On a workload those regexes miss,
every per-family gate collapses into one bucket.

`skills/rightmodeler/scripts/judge.py` (retired; replaced by the TypeScript harness, see
`harness/docs/Architecture.md`) mapped the ordinal verdict to `{1.0, 0.6, 0.0}` and
averages two position-swapped calls, so the only achievable single-case scores are
`{0.0, 0.3, 0.5, 0.6, 0.8, 1.0}`. Any quality floor above 0.8 is therefore exactly the
test "both orderings said equivalent". The ordinal scale is an illusion at the default
floor. The silver lining is that this makes per-case outcomes honestly Bernoulli, which is
what legitimises a Wilson interval on the pass rate.
