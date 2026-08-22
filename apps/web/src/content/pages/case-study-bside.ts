// Markdown twin of /case-study/bside (app/case-study/bside/page.tsx). Keep in sync with that page:
// every figure here is quoted verbatim from the engagement write-up, baseline stamped
// assumed/projected and right-sized quality stamped measured.

import { REPO_URL, RUN_COMMAND } from "@/lib/site";

export const markdown = `# From brute-force reasoning to precision routing

Case study · B:Side Assist · July 22, 2026 · 4 min read

[B:Side Assist](https://www.bsideassist.com) is a financial intelligence platform that helps businesses understand their financial position. Its AI copilot, AI Assist, answers questions using connected bank accounts, transactions, uploaded financial documents, business context, and current research.

To the user, it is one chat response. Behind the scenes, producing that response can involve several specialized AI jobs: one model call interprets the question, another inspects a document, another calculates a financial scenario, and another validates or repairs the final answer. AI Assist runs 11 of these layers, from greetings and summaries to validation, research, vision, and recovery.

Each layer asks for something different. A greeting or a summary should be fast and inexpensive, while validating financial calculations or conducting grounded research deserves deeper reasoning. Right-sizing that stack produced the numbers below.

**ai assist · right-sized outcome** (projected per 20 queries)

- 70.8% lower inference cost
- 53.3% faster end to end
- 114.3% higher throughput

pass rate held at 100%, measured on the same benchmark

## The challenge

The assumed starting architecture used gpt-5.6-terra with xhigh reasoning across every AI Assist layer. Terra is a capable, balanced model, and xhigh tells it to devote substantial reasoning effort to the task. That combination makes sense for difficult financial analysis. As the default for everything, it treats routine extraction and genuinely difficult analysis as if they were the same job, and it maximizes theoretical reasoning in places nobody benefits from it.

> It was the AI equivalent of using a supercomputer to sort a spreadsheet: exceptionally capable, but unnecessarily expensive and slow for much of the work.

And the waste compounds. One user question can trigger multiple model calls, so small inefficiencies at each layer accumulate into slower responses and higher inference costs.

## What rightmodeler changed

rightmodeler evaluated AI Assist as 11 distinct workloads rather than one generic AI request. Each layer was benchmarked on its own traces and matched to the cheapest model and reasoning effort that held its quality bar. The resulting policy:

**rightmodeler · routing policy · ai assist** (baseline: terra · xhigh everywhere)

| route | covers |
| --- | --- |
| luna · low | quick responses, follow-ups, summaries |
| luna · medium | document extraction and vision |
| luna · high | Business Wiki and failure recovery |
| luna · xhigh | grounded research, the only xhigh route |
| terra · high | orchestration, validation, repair |
| sol | reserved for demanding fallbacks |

The shape of the policy tells the story. Most of the traffic moves to Luna. Terra stays only where it earns its price: orchestration, validation, and repair, the layers where a wrong answer is expensive. xhigh reasoning survives in exactly one place, grounded research, where reasoning depth is the product itself. And Sol waits in reserve for the rare fallback that genuinely needs it.

## Projected results

These figures model the all Terra, all xhigh starting point using actual benchmark traces, current OpenAI pricing, and the observed xhigh reasoning and latency uplift from the grounded research workload.

**rightmodeler · ai assist evaluation** (per 20 queries · 11 workloads)

| metric | all terra · xhigh | right-sized | improvement |
| --- | --- | --- | --- |
| inference cost | $0.05119 | $0.01493 | 70.8% lower |
| total response time | 50.46s | 23.54s | 53.3% faster |
| avg response time | 2.523s | 1.177s | 1.346s saved/query |
| reasoning tokens | 2,347.64 | 730.30 | 68.9% fewer |
| total tokens | 6,552.79 | 4,935.45 | 24.7% fewer |
| throughput | 23.78 q/min | 50.97 q/min | 114.3% higher |
| quality pass rate | 100% assumed | 100% measured | 0-point difference |

modeled from actual benchmark traces · current OpenAI pricing · observed xhigh uplift from grounded research

The row that matters most is the one that did not move. The baseline assumed a 100% quality pass rate; the right-sized policy measured 100% on the same benchmark. Cheaper and faster only count if quality holds.

> The savings are only real because quality held: 100% measured, not assumed.

## At scale

The evaluation covered 20 queries. Applying its modeled per-query cost difference linearly gives:

**ai assist · savings at volume** (linear projection from 20 queries)

- $1.81 saved per 1,000 queries
- $1,813 saved per million queries

projected from the 20-query evaluation · current Standard pricing

The mechanics are simple. Current Standard pricing puts Terra at $2.50 per million input tokens and $15 per million output tokens, while Luna runs $1 and $6. Every routine call that Luna handles at a fraction of Terra's price, at equal measured quality, is margin recovered.

This is what rightmodeler produces: not a cheaper model, a policy. Eleven workloads, each on the smallest model and reasoning effort that met its configured benchmark bar, with Terra and Sol kept for the work that deserves them.

> "rightmodeler took AI Assist from brute force to precision routing. Costs fell 70.8%, responses got twice as fast, and quality held at 100%, measured, not assumed."

**Chris Myers**, CEO, B:Side Capital and Fund

## Run it on your own traces.

    ${RUN_COMMAND}

Free until replay, then your own provider key. It is a report, not a runtime gateway.

View on GitHub: ${REPO_URL}
`;
