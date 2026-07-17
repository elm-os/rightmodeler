// Post: "The Tuesday problem" — part two of the vision series (rightmodeler agent). A typed post
// module: `meta` (data) plus a `Body` composed from the prose primitives. Registered in ./index.
// Voice matches the founding story: measured, honest, story-first. The Tuesday scene is a
// composite every agent team will recognize; no named customers, no invented traction. No accent
// hues in the copy; the accents live in the hero art.

import { A, H2, Lead, P, Prose, PullQuote } from "@/components/blog/prose";
import type { PostMeta } from "@/content/blog/types";

export const meta: PostMeta = {
  slug: "the-tuesday-problem",
  title: "The Tuesday problem.",
  description:
    "A new model drops every few weeks, and evaluating it properly is a project nobody budgets. Part two of the rightmodeler vision: the agent that turns model migrations into pull requests.",
  excerpt:
    "The group chat asks: are we switching? And everyone goes quiet. Part two of our vision: why model migrations should arrive as pull requests with the evidence attached.",
  kicker: "The vision · Part two",
  date: "2026-07-10",
  readingMinutes: 6,
  hero: {
    src: "/blog/the-tuesday-problem-hero.jpg",
    alt: "A warm parchment field where a grain-textured gradient path forks in rightmodeler's violet and orange brand accents.",
  },
};

export function Body() {
  return (
    <Prose>
      <Lead>
        The new model dropped on a Tuesday, because they always seem to drop on
        a Tuesday. By ten the group chat was a wall of benchmark screenshots. By
        quarter past, someone had asked the only question that matters: so, are
        we switching? And then everyone went quiet and looked at the one
        engineer who owns the model configs.
      </Lead>

      <P>
        If you run agents in production, you know that silence. It is the sound
        of a person doing bad math quickly. Because the honest answer to
        &ldquo;are we switching&rdquo; is a project, and everyone in the chat
        knows nobody budgeted for it.
      </P>

      <H2>Both options are bad</H2>

      <P>
        Done properly, the evaluation looks like this. Pull a few hundred real
        traces. Build a harness to replay them through the new model, step by
        step, with the same tools and the same context. Judge the outputs
        against what you already shipped, carefully, because eyeballing is how
        regressions sneak through. Price the whole thing at your real token mix,
        not the launch table&rsquo;s. Write it up so the swap survives review.
        That is two days if the harness already exists, and closer to a week if
        it does not. And the next model lands in three weeks, so you get to do
        it all again.
      </P>

      <P>
        The alternative is what most teams actually do: nothing. Keep paying
        yesterday&rsquo;s price for yesterday&rsquo;s model and tell yourself
        you will evaluate next sprint. Or worse, swap on vibes because the
        timeline was excited, and find out from a user which edge cases got
        worse.
      </P>

      <P>
        We spent years on that treadmill ourselves; the{" "}
        <A href="/blog/why-we-built-rightmodeler">founding story</A> is mostly
        about it. The arithmetic is uncomfortable. Comparable models routinely
        sit ten times apart on price, and a step that could run dramatically
        cheaper keeps burning money on every call, every retry, every user,
        every day, for exactly as long as the evaluation stays unscheduled.
        Skipping the question does not make it free. It makes it compound. And
        it cuts the other way too: sometimes the new model is simply better at
        the same price, and the cost of not deciding is shipping worse quality
        than you could.
      </P>

      <PullQuote>
        Evaluating one model once is a project. Evaluating every model forever
        is a job.
      </PullQuote>

      <H2>A cadence problem, not a judgment problem</H2>

      <P>
        Engineers are not bad at the judgment part. Given the replays, the
        scores, and the deltas, most teams make the right call in minutes. What
        breaks people is the cadence. A frontier release every few weeks,
        multiplied by every step in your stack, multiplied by every provider, is
        not a task you finish. It is a standing job. And standing jobs with
        clear inputs, checkable evidence, and a crisp definition of done are
        exactly the jobs we hand to software.
      </P>

      <H2>A migration should be a pull request</H2>

      <P>
        So here is the shape we are building toward.{" "}
        <A href="/agent">rightmodeler agent</A> watches every release. When a
        new model could beat a step in your stack, it replays that step on your
        real traces in a sandbox, judges the outputs against what you already
        shipped, and checks the result against your preferences file: your
        quality floor, your minimum saving, your latency budget, the providers
        you allow, the steps it must never touch.
      </P>

      <P>
        When a candidate clears the bar, it opens a pull request in your repo.
        The diff is one line. Attached to it are the receipts: quality scores
        judged against your shipped outputs, the cost delta, the latency delta,
        the confidence, and the replayed traces behind all of it. Your Tuesday
        shrinks to code review. You read the evidence, maybe spot-check a trace,
        and merge or close. It never merges on its own.
      </P>

      <P>
        And when no candidate clears the bar, there is no PR. The agent
        abstains, exactly like the engine it is built on, because a tool that
        always finds a swap is not measuring anything.
      </P>

      <H2>Today, and next Tuesday</H2>

      <P>
        The proof engine already exists. The{" "}
        <A href="https://github.com/elm-os/rightmodeler">rightmodeler skill</A>{" "}
        runs the same replay-and-judge loop on your own traces today, one
        command to install. The agent takes that loop and gives it a calendar.
        It is in active development; join the waitlist on{" "}
        <A href="/agent">the agent page</A> and we will send one note when early
        access opens.
      </P>

      <P>
        This is part two of the vision. Part one is about seeing: why your agent
        bill has no line items, and what{" "}
        <A href="/blog/the-bill-nobody-can-read">Crucible does about it</A>.
      </P>
    </Prose>
  );
}

// The same post as clean Markdown, for llms-context.txt and any LLM-facing surface. Kept in sync with
// Body above by hand.
export const markdown = `# The Tuesday problem.

The new model dropped on a Tuesday, because they always seem to drop on a Tuesday. By ten the group chat was a wall of benchmark screenshots. By quarter past, someone had asked the only question that matters: so, are we switching? And then everyone went quiet and looked at the one engineer who owns the model configs.

If you run agents in production, you know that silence. It is the sound of a person doing bad math quickly. Because the honest answer to "are we switching" is a project, and everyone in the chat knows nobody budgeted for it.

## Both options are bad

Done properly, the evaluation looks like this. Pull a few hundred real traces. Build a harness to replay them through the new model, step by step, with the same tools and the same context. Judge the outputs against what you already shipped, carefully, because eyeballing is how regressions sneak through. Price the whole thing at your real token mix, not the launch table's. Write it up so the swap survives review. That is two days if the harness already exists, and closer to a week if it does not. And the next model lands in three weeks, so you get to do it all again.

The alternative is what most teams actually do: nothing. Keep paying yesterday's price for yesterday's model and tell yourself you will evaluate next sprint. Or worse, swap on vibes because the timeline was excited, and find out from a user which edge cases got worse.

We spent years on that treadmill ourselves; the [founding story](https://www.rightmodeler.com/blog/why-we-built-rightmodeler) is mostly about it. The arithmetic is uncomfortable. Comparable models routinely sit ten times apart on price, and a step that could run dramatically cheaper keeps burning money on every call, every retry, every user, every day, for exactly as long as the evaluation stays unscheduled. Skipping the question does not make it free. It makes it compound. And it cuts the other way too: sometimes the new model is simply better at the same price, and the cost of not deciding is shipping worse quality than you could.

> Evaluating one model once is a project. Evaluating every model forever is a job.

## A cadence problem, not a judgment problem

Engineers are not bad at the judgment part. Given the replays, the scores, and the deltas, most teams make the right call in minutes. What breaks people is the cadence. A frontier release every few weeks, multiplied by every step in your stack, multiplied by every provider, is not a task you finish. It is a standing job. And standing jobs with clear inputs, checkable evidence, and a crisp definition of done are exactly the jobs we hand to software.

## A migration should be a pull request

So here is the shape we are building toward. [rightmodeler agent](https://www.rightmodeler.com/agent) watches every release. When a new model could beat a step in your stack, it replays that step on your real traces in a sandbox, judges the outputs against what you already shipped, and checks the result against your preferences file: your quality floor, your minimum saving, your latency budget, the providers you allow, the steps it must never touch.

When a candidate clears the bar, it opens a pull request in your repo. The diff is one line. Attached to it are the receipts: quality scores judged against your shipped outputs, the cost delta, the latency delta, the confidence, and the replayed traces behind all of it. Your Tuesday shrinks to code review. You read the evidence, maybe spot-check a trace, and merge or close. It never merges on its own.

And when no candidate clears the bar, there is no PR. The agent abstains, exactly like the engine it is built on, because a tool that always finds a swap is not measuring anything.

## Today, and next Tuesday

The proof engine already exists. The [rightmodeler skill](https://github.com/elm-os/rightmodeler) runs the same replay-and-judge loop on your own traces today, one command to install. The agent takes that loop and gives it a calendar. It is in active development; join the waitlist on [the agent page](https://www.rightmodeler.com/agent) and we will send one note when early access opens.

This is part two of the vision. Part one is about seeing: why your agent bill has no line items, and what [Crucible does about it](https://www.rightmodeler.com/blog/the-bill-nobody-can-read).
`;
