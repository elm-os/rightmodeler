// Markdown twin of the /case-study/iam360 route (src/app/case-study/iam360/page.tsx).
// Keep it in sync with that page: same copy, same figures, same modeled hedges.

import { REPO_URL, RUN_COMMAND } from "@/lib/site";

export const markdown = `# How iAM360 made its AI coach dramatically more efficient without lowering the quality bar

Case study · iAM360 · July 22, 2026 · 5 min read

[iAM360](https://www.iam360.ai) is a fitness and wellness platform that helps people understand their wearable, workout, nutrition, sleep, and recovery data. Its AI coach turns that information into practical answers: how hard to train, when to recover, what patterns are affecting progress, and what to do next. A connected trainer platform helps coaches manage clients and create programs.

That means the AI handles very different kinds of work. Some requests require serious reasoning, such as analyzing weeks of health data or building a personalized plan. Others are much simpler: identifying the date of a meal photo, classifying a message, or returning information in a predefined format.

**iam360 · routed outcome** (modeled from 1 representative request)

- 56-57% lower cost per request
- $41,000 projected savings per million requests
- 25-26% from routing alone, at identical usage

million-request figure is a linear projection from one representative request · hypothetical all terra · xhigh baseline

## The starting point

Originally, the system was modeled as if every task used gpt-5.6-terra with its highest reasoning setting, xhigh. For the hardest analysis, that pairing is exactly right. As the default for every request, it is expensive precision applied to work that never asked for it.

> Like hiring a senior specialist to handle everything from strategic decisions to routine paperwork: the quality is high, but the cost and response time are unnecessarily high.

## What rightmodeler changed

Using rightmodeler's routing and evidence framework, iAM360 taught the system to assign each job to the appropriate level of AI.

**rightmodeler · routing policy · iam360** (baseline: terra · xhigh everywhere)

| route | covers |
| --- | --- |
| gpt-5.6-sol | complex coaching and personalized planning |
| gpt-5.6-terra | moderate analysis |
| gpt-oss-20b · groq | straightforward, heavily validated work |
| gpt-oss-120b | a small number of controlled fallbacks |

> We did not remove intelligence. We concentrated it where users actually benefit from it.

The counterintuitive part: right-sizing went in both directions. Some complex coaching paths were upgraded from Terra to flagship Sol at the same time narrowly defined routine tasks moved to smaller, faster models. The routing changed more than the models, too:

**what changed** (previously modeled → current)

| Before | After |
| --- | --- |
| The same expensive model handled everything | Each task uses an appropriately capable model |
| Maximum reasoning, even for simple work | Reasoning effort matches the difficulty of the request |
| Conversations repeatedly resent large amounts of context | Conversations continue efficiently over OpenAI WebSockets |
| Temporary failures could trigger several expensive retries | Retries and fallbacks are strictly limited |
| Large models could end up doing routine work | Smaller, faster models handle validated routine tasks |

## The modeled savings

The comparison baseline is a hypothetical starting point where every request uses Terra with xhigh reasoning. At identical text usage, smarter routing alone reduces the modeled AI cost by approximately 25 to 26%. The larger saving comes from avoiding excessive reasoning on simple tasks.

**iam360 · modeled cost per call** (representative request)

- all terra · xhigh: $0.0725
- routed architecture: $0.0314-$0.0319
- savings: 56.0-56.7%

In a representative request, the routed system costs approximately 3.1 cents where the all-Terra xhigh version costs approximately 7.25 cents: a modeled saving of roughly 56 to 57% per request.

The honest caveat is that the headline depends on how much extra output and reasoning xhigh actually produces. Even in the most conservative case, identical output volume, routing alone still saves 25 to 26%:

**sensitivity · terra-xhigh output multiplier** (modeled savings)

- same output volume: 25-26%
- 1.5× output + reasoning: 44-45%
- 2× output + reasoning: 56-57%

the representative request assumes the 2× case, consistent with observed xhigh behavior

## What happened to quality?

The smaller models are not trusted with every request. They are assigned narrowly defined tasks with predictable outputs and automated validation. The most difficult work still receives a flagship model, and some complex paths were upgraded from Terra to Sol.

## At scale

The model uses one representative request shape. Applying its per-request cost difference linearly gives:

**iam360 · savings at volume** (linear projection from 1 representative request)

- $4,100 saved per 100,000 requests
- $41,000 saved per million requests

projected from one representative request · current pricing

This is what rightmodeler produces: a routing policy where every job is assigned under the stated validation procedure, with the flagship kept, and sometimes promoted, for the work that deserves it.

> "rightmodeler concentrated intelligence where our members feel it. The hardest coaching moved up to Sol, routine work got faster, and cost per request dropped by more than half."

**Brian Douglas**, Founder, iAM360

## Run it on your own traces.

    ${RUN_COMMAND}

Free until replay, then your own provider key. It is a report, not a runtime gateway.

View on GitHub: ${REPO_URL}
`;
