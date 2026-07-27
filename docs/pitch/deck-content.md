# rightmodeler master deck, slide-by-slide content

Purpose: one master deck for investors, partners, and recruits. No ask slide by design.
Read this with `docs/design.md`; every visual derives from those tokens.

Rules baked into every slide:

- Light on-slide copy: a headline, at most two support lines, one visual. The deck must stand alone without a narrator (Venture Deals), and every headline is a takeaway.
- No em dashes anywhere. No semantic color. Type and UI stay monochrome ink on
  parchment; void-violet `#0447ff` and ember-orange `#ff4704` live only inside the
  dithered imagery (the site's gradient palette), never on text, chips, or buttons.
- Photographs carry the Bayer dither treatment in the site's gradient colors
  (already applied to supplied assets). Line-art diagrams stay crisp ink so labels
  survive projection. Logos are never dithered, never restyled.
- Every number on a slide carries a source footnote. Numbers we cannot cite stay off
  slides. Illustrative examples are labeled illustrative.
- Traction is framed as validated learning (Lean Startup): pain felt, tool built,
  used at real companies, generalized into a shipped open-source skill. No vanity
  metrics, no invented users, no fantasy financials.

The three-sentence pitch (slide 1 must land this in 15 seconds):
rightmodeler decides which model belongs at every layer of your AI agents. It proves
each decision by replaying your own traces, then keeps it current as new models ship.
Teams stop paying frontier prices for work a cheaper model does just as well.

---

## Slide 1. Title

- **Headline:** rightmodeler (wordmark lockup)
- **Subline:** The right model for every layer of your AI agents, proven on your own traces.
- **Footer line:** rightmodeler.com
- **Visual:** full-bleed dithered hero image `01-hero.png` (layered paper sheets with a violet-to-orange gradient glow, dither in original colors). Wordmark and subline set in ink on a parchment panel.
- **Speaker notes:** One breath: we are the decision layer for the models inside AI agents. Everything downstream of this slide is evidence for that sentence.

## Slide 2. Origin

- **Headline:** We were picking models by vibes. Then the bill arrived.
- **Support:** We build multiagent systems for a living. Every system asked the same question: which model belongs at each layer?
- **Support 2:** We built an internal tool to answer it. Engineers at every company we talked to had the same problem.
- **Visual:** logo row on neutral warm-sand cards, most recognizable first: Amazon, PayPal, ASU, B:Side Capital and Fund, Vanderbilt Financial Group (crisp, untouched; ASU replaced the Colyap mark and PayPal replaced the VCOS mark per Aakash, Colyap and VCOS stay in the spoken origin story). Above it, dithered photo `02-origin.png` (engineers at a whiteboard, hands and silhouettes, no identifiable faces).
- **Speaker notes:** The headline is the title of our founding-story essay. Company set spans big tech (Amazon), SBA lending (B:Side), impact investing (Vanderbilt Financial Group), an autonomous phone-call agent (Colyap), and an AI operating system for VC (VCOS). The internal tool ran at B:Side, VCOS, and Colyap; at the others we ran the same workflow by hand before the tool existed. This is the validated-learning chain, not a customer list.

## Slide 3. Problem, part one: decision debt

- **Headline:** Every layer is a model decision. Every release reopens it.
- **Stat callouts:**
  - 59 notable US model releases in 2025, one every few weeks. (Stanford HAI, AI Index Report 2026)
  - Only 11% of builders switched vendors in a year; a single launch flipped 45% of one provider's users in a month. (Menlo Ventures, 2025 Mid-Year LLM Market Update)
- **Support:** An agent is a stack of steps, and each step has its own cost, speed, and quality bar. Evaluating one model once is a project. Evaluating every model forever is a job.
- **Visual:** line-art diagram `03-stack.png`: an agent pipeline of five labeled steps, each with an empty model slot and a question mark, a release ticker raining new model names from above.
- **Speaker notes:** Two forces compound: stacks got deep (many decisions) and releases got frequent (each decision reopens every few weeks). Teams resolve the tension by not deciding: they stay put (the 11%) until a launch shockwave forces a migration scramble (the 45% in a month). Both failure modes are expensive.

## Slide 4. Problem, part two: standing still is expensive

- **Headline:** The default is over-provisioned, and it decays.
- **Stat callouts:**
  - Same capability, roughly 10x cheaper every year. (a16z, Welcome to LLMflation, 2024; corroborated by Epoch AI, 2025)
  - The frontier tier costs 10x the small tier per token on today's Anthropic price list. (Anthropic pricing, verified July 2026)
- **Support:** A model choice that was right in January is overpriced by summer. Most agent layers never get re-asked.
- **Visual:** line-art diagram `04-decay.png`: a falling price-per-capability curve against a flat "what you still pay" line, the gap shaded as waste.
- **Speaker notes:** This is why the problem never closes: even if no new model beats yours on quality, the price floor drops under you continuously. Checkr's public case lands here if asked: one workload moved from GPT-4 to a fine-tuned 8B model, roughly 90% cheaper, accuracy up from 88% to 97% (Computerworld, 2024). Proof that right-sizing is real money, not margin-of-error.

## Slide 5. The insight

- **Headline:** Generic benchmarks can't answer it. Your traces can.
- **Support:** Leaderboards rank models on someone else's tasks. The only benchmark that matters is what your agent already shipped and you accepted.
- **Support 2:** Replay real traces through candidate models, judge against your own accepted outputs, and the decision makes itself.
- **Visual:** line-art diagram `05-traces.png`: left, a leaderboard podium crossed out; right, a loop: your traces, replay, judge, decision.
- **Speaker notes:** This is the core belief the products are built on: your traces are the benchmark. It is also the moat argument in miniature: the data that makes decisions trustworthy already belongs to the customer, and we are the only ones who turn it into a decision where it lives, in the repo.

## Slide 6. The product today: the open-source skill

- **Headline:** Detect. Prove. Fix. Shipped and open source.
- **Three steps (icon row, minimal labels):**
  - Reads the traces you already have. Autodetects 8 trace formats.
  - Replays each step through cheaper models, judges against your shipped outputs. High-risk steps abstain: it can say no.
  - Hands you a per-step swap plan with dollar savings. You approve every swap.
- **Terminal line (mono):** npx skills add elm-os/rightmodeler
- **Visual:** line-art diagram `06-skill.png`: three-stage pipeline ending in a per-step approval table (model, cheaper candidate, savings, confidence, one abstained row). Status chip: Available now.
- **Speaker notes:** Show, don't describe: this exists, installs in one line, and runs on the user's own provider key (OpenRouter, the Vercel AI Gateway, or LiteLLM). Judging discipline matters: deterministic checks first, cross-family judges, order-swapped verdicts, abstention on weak evidence. It is a report with evidence, not observability and not a runtime gateway.

## Slide 7. Next: the rightmodeler agent

- **Headline:** The last model migration you do by hand.
- **Support:** A new model ships. The agent replays it against your traces in CI, prices the swap, and opens a pull request with the evidence attached.
- **Support 2:** Weak evidence means no PR. Nothing merges without you.
- **Visual:** line-art diagram `07-agent.png`: a GitHub-style PR card titled "swap step 3 to a cheaper model", an evidence panel (quality score, cost delta, traces replayed), flow chips: Watch, Replay, Judge, PR. Status chip: Coming soon, waitlist live.
- **Speaker notes:** The mental model: platforms ship first-party agents now (Vercel has one for deploys); this is ours, for model decisions, living in your repo and CI. It turns the skill's one-time report into a standing service: every release evaluated against your stack, forever. That recurring loop is what people pay for.

## Slide 8. Next: Crucible

- **Headline:** Crucible: every layer, measured and right-sized.
- **Support:** The analytics suite for AI agents: cost by layer, speed by step, failures as they happen, continuously right-sized.
- **Support 2:** Connects over MCP. Your keys, your routes. Not a gateway.
- **Visual:** line-art diagram `08-crucible.png`: dashboard sketch with a cost-by-layer bar block, a p50/p95 speed strip, a live failure feed, and a right-size recommendation card. Status chip: Early access.
- **Speaker notes:** Crucible closes the loop: the agent decides at release time, Crucible watches production continuously and feeds drift back into the next decision. Together they make model choice a managed system instead of an annual scramble.

## Slide 9. Business: the wedge and the engine

- **Headline:** Open source is the wedge. The decision layer is the business.
- **Support:** The skill stays free and open source: it earns trust and teaches us every trace format in the wild.
- **Support 2:** The agent and Crucible are the paid products: open-core SaaS, priced per repo and per agent fleet.
- **Visual:** line-art diagram `09-wedge.png`: three ascending steps labeled skill (free, adoption), agent (paid, per repo), Crucible (paid, per fleet), an arrow looping back labeled "every new release pulls users back".
- **Speaker notes:** The growth engine is sticky by construction (Lean Startup's sticky engine): a one-time model choice decays, so staying current is a subscription-shaped problem. Every headline model launch is a free re-activation event for us. Pricing specifics are deliberately not public yet; do not quote numbers.

## Slide 10. What we are not

- **Headline:** Routers pick a lane per request. We decide the stack.
- **Three columns (one line each):**
  - Runtime routers (OpenRouter, Martian): route each request at the proxy, blind to your quality bar.
  - Eval and observability platforms (LangSmith, Braintrust, Arize): measure outputs, stop short of the decision.
  - FinOps (CloudZero, Finout): see the bill after the fact, never the quality.
- **Support:** Nobody else sits in the repo, runs your evals against every release, and ships the decision as a PR. Also not: a cost trimmer for coding assistants.
- **Visual:** line-art diagram `10-map.png`: 2x2 map, axes "decides vs observes" and "your evals vs generic"; rightmodeler alone in the decides-with-your-evals quadrant, competitor clusters in the other three.
- **Speaker notes:** Adjacent funding prices the problem: OpenRouter $113M at $1.3B (2026), LangChain $125M at $1.25B (2025), Braintrust $80M (2026), Arize $70M (2025), Galileo $45M (2024), CloudZero $56M (2025), Finout $40M (2025). All validated, none in our seat. We happily ride on routers as rails (the skill replays through OpenRouter, the Vercel AI Gateway, or LiteLLM) while owning the decision above them.

## Slide 11. Market

- **Headline:** The spend is real. The decision layer is missing.
- **Stat callouts (three, no more):**
  - $37B US enterprise genAI spend in 2025, up 3.2x year over year. (Menlo Ventures, 2025)
  - $12.5B of it on foundation model APIs, the pool model decisions steer. (Menlo Ventures, 2025)
  - AI agents market: $7.84B in 2025 to $52.6B by 2030, 46.3% CAGR. (MarketsandMarkets, 2025)
- **Support:** Bottom-up, re-deciding model fit by hand is on the order of $1.5B a year of engineering time, before any savings are counted.
- **Visual:** dithered photo `11-market.png` (aerial river-delta terrain) behind a simple three-ring diagram: model-API pool, agent teams, rightmodeler's seat.
- **Speaker notes:** Bottom-up math, stated as assumptions: roughly 20,000 teams running agents in production, each seriously re-evaluating about 8 releases a year at about 40 engineering hours and $120 loaded cost: 20,000 x 8 x 40 x $120 is $1.5B of labor we automate. Savings side: if 20 to 40% of the $12.5B pool is over-provisioned and right-sizing recovers half or more, $1.25B to $3.75B a year is recoverable. Both roads land in the same order of magnitude, and the pool compounds at 46% underneath.

## Slide 12. Traction and road

- **Headline:** Felt the pain. Built the tool. Shipped the wedge.
- **Three columns, no dates:**
  - Today: open-source skill, available now. Born as an internal tool, used in production work at B:Side, VCOS, and Colyap.
  - Next: rightmodeler agent (waitlist live) and Crucible (early access): from one-time report to always-current decisions.
  - Vision: the cost-optimization layer for every business building on LLMs.
- **Visual:** line-art diagram `12-road.png`: a path with three markers; the first marker filled ink, the next two outlined.
- **Speaker notes:** Frame strictly as learning velocity, not adoption claims: each stage exists because the previous one taught us something at a real company. No user counts or revenue yet, and we say so plainly if asked; the waitlists are the only public funnel today.

## Slide 13. Team

- **Headline:** Four engineers who lived this problem.
- **Typographic cards, no photos (name, Co-founder, one line):**
  - Aakash Harish. Co-founder. Founder of VCOS; built B:Side Assist; AI products across fintech and VC.
  - Ameya Lambat. Co-founder. AI systems at ASU's DigitalDx lab; built Token Receipt, cost tracking for AI agents; previously PayPal, Onshape, Corsair.
  - Piyussh Singhal. Co-founder. Built B:Side Assist and Colyap; founder of Alchemy Labs, AI agents for SMB automation.
  - Chaitanya Chaurasia. Co-founder. Engineer at eero (Amazon); mesh-wifi stability patent; cut fleet noise events from about 1M a day to 10k.
- **Support (one line under the grid):** We built multiagent systems at Amazon, B:Side, Vanderbilt Financial Group, Colyap, and VCOS. rightmodeler is the tool we kept wishing existed.
- **Visual:** type-only grid on warm-sand cards; a narrow dithered texture band `13-team-band.png` as the slide's base rule.
- **Speaker notes:** The deck follows the spelling on Chai's own site (thechai.fyi), Chaurasia; Aakash originally wrote Chaurasiya, so confirm Chai's preferred form before wide distribution. Every line above traces to the founders' own sites.

## Slide 14. Close

- **Headline:** A model decision deserves evidence, not a vibe.
- **Support:** Prove it on your own traces today. Let the agent keep it true tomorrow.
- **Footer:** rightmodeler.com · npx skills add elm-os/rightmodeler · waitlists open for agent and Crucible
- **Visual:** full-bleed dithered hero echo `14-close.png` (same paper-layers family as slide 1, violet-to-orange accent, original-colors dither).
- **Speaker notes:** End where the manifesto begins: evidence beats vibes. The three doors for any audience: run the skill (developers), join a waitlist (design partners), or continue the conversation (investors, recruits).

---

## Source footnotes (for the deck's appendix or per-slide footers)

1. Menlo Ventures, 2025: The State of Generative AI in the Enterprise. menlovc.com/perspective/2025-the-state-of-generative-ai-in-the-enterprise/
2. Menlo Ventures, 2025 Mid-Year LLM Market Update. menlovc.com/perspective/2025-mid-year-llm-market-update/
3. Stanford HAI, AI Index Report 2026, Chapter 1 (Epoch AI data). hai.stanford.edu/assets/files/ai_index_report_2026.pdf
4. a16z, Welcome to LLMflation, 2024. a16z.com/llmflation-llm-inference-cost/ (corroboration: epoch.ai/data-insights/llm-inference-price-trends)
5. Anthropic, Claude API pricing, verified 2026-07-17. platform.claude.com/docs/en/about-claude/pricing
6. Computerworld, Checkr ditches GPT-4 for a smaller genAI model, 2024. computerworld.com/article/3541362/
7. MarketsandMarkets, AI Agents Market, 2025. marketsandmarkets.com/PressReleases/ai-agents.asp
8. KPMG AI Quarterly Pulse Survey, Q1 2026. kpmg.com/us/en/media/news/q1-ai-pulse2026.html
9. a16z, enterprise CIO survey, Jan 2026. a16z.com/leaders-gainers-and-unexpected-winners-in-the-enterprise-ai-arms-race/
10. Funding: TechCrunch (OpenRouter, 2026; Finout, 2025), LangChain blog (2025), Braintrust blog (2026), Arize blog (2025), PR Newswire (Galileo, 2024), CloudZero press release (2025).

## Asset manifest (all produced by the imagery pipeline)

| File             | Slide | Type                                       | Treatment                            |
| ---------------- | ----- | ------------------------------------------ | ------------------------------------ |
| 01-hero.png      | 1     | photo, paper layers + gradient glow        | dithered, original colors            |
| 02-origin.png    | 2     | photo, engineers at whiteboard             | dithered, violet/orange on parchment |
| 03-stack.png     | 3     | diagram, agent stack + release ticker      | crisp line art                       |
| 04-decay.png     | 4     | diagram, price decay vs flat spend         | crisp line art                       |
| 05-traces.png    | 5     | diagram, leaderboard vs trace loop         | crisp line art                       |
| 06-skill.png     | 6     | diagram, detect-prove-fix + approval table | crisp line art                       |
| 07-agent.png     | 7     | diagram, PR card with evidence             | crisp line art                       |
| 08-crucible.png  | 8     | diagram, dashboard sketch                  | crisp line art                       |
| 09-wedge.png     | 9     | diagram, three steps + loop-back           | crisp line art                       |
| 10-map.png       | 10    | diagram, 2x2 positioning map               | crisp line art                       |
| 11-market.png    | 11    | photo, aerial river delta                  | dithered, violet/orange on parchment |
| 12-road.png      | 12    | diagram, three-marker path                 | crisp line art                       |
| 13-team-band.png | 13    | texture band                               | dithered, violet/orange on parchment |
| 14-close.png     | 14    | photo, paper layers echo                   | dithered, original colors            |
| logos/ (6 files) | 2     | company + rightmodeler logos               | untouched, never dithered            |
