import { A, H2, Lead, P, Prose, PullQuote } from "@/components/blog/prose";
import type { PostMeta } from "@/content/blog/types";

export const meta: PostMeta = {
  slug: "the-tuesday-problem",
  title: "The Tuesday problem.",
  description:
    "Why evaluating every new model becomes a project nobody budgets. Part two of the rightmodeler vision: take the work out of the loop, not the judgment.",
  excerpt:
    "The group chat asks: are we switching? And everyone goes quiet. Part two of our vision: take the work out of the loop, not the judgment, and let each cheaper or newer model swap arrive as a draft pull request with the evidence attached.",
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
        step, with the same context. Judge the outputs against what you already
        shipped, carefully, because eyeballing is how regressions sneak through.
        Price the whole thing at your real token mix, not the launch
        table&rsquo;s. Write it up so the swap survives review. That is two days
        if the harness already exists, and closer to a week if it does not. And
        the next model lands in three weeks, so you get to do it all again.
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
        about it. The arithmetic is uncomfortable. The price spread across
        plausible candidates can be large, and an over-provisioned step keeps
        burning money on every call, every retry, every user, every day, for
        exactly as long as the evaluation stays unscheduled. Skipping the
        question does not make it free. It makes it compound. And it cuts the
        other way too: a new release may perform better at a similar price, so
        declining to evaluate it can also leave quality on the table.
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

      <P>
        Put plainly, we think the biggest bottleneck in maintaining software is
        the human in the loop: not the judgment, the work. The work is
        everything before the call: noticing the release, building the replay,
        grading the outputs, writing it up, and migrating, every few weeks,
        forever. rightmodeler takes that work out of the loop, not the judgment.
      </P>

      <H2>A cheaper or newer model swap should be a pull request</H2>

      <P>
        So here is the shape of it. <A href="/agent">rightmodeler agent</A> runs
        a weekly catalog and price check that flags cheaper new or repriced
        models for the steps in your stack. On your word, it replays those
        candidates on your recorded traces, offline, and a judge from a
        different vendor, or your own evaluator, grades every answer against the
        output you already accepted. It works inside the policy you set: your
        quality floor, the shortlist size, the models it may and may not try,
        and an optional spend cap.
      </P>

      <P>
        The bar is every release gate: agreement with the outputs you accepted,
        at a statistical lower bound that reaches your quality floor on held-out
        cases, with swaps that feed later model steps confirmed end to end in a
        sandbox. rightmodeler measures agreement with what you shipped, not
        ground-truth correctness.
      </P>

      <P>
        When a candidate clears every gate, the agent opens a draft pull request
        in your repo. The diff changes only model identifiers. Attached to it
        are the receipts: the lower bound, the cost per case for the recorded
        model and the candidate, the sample size, and case IDs for the replays
        behind it. Your Tuesday shrinks to the part you were always good at: the
        judgment. You read the evidence, maybe spot-check a trace, and merge or
        close. The agent never merges and carries no merge capability.
      </P>

      <P>
        And when no candidate clears every gate, there is no pull request. When
        the evidence is thin, the agent abstains and names the reason, exactly
        like the engine it is built on, because a tool that always finds a swap
        is not measuring anything.
      </P>

      <H2>Today, and next Tuesday</H2>

      <P>
        The engine is the{" "}
        <A href="https://github.com/elm-os/rightmodeler">rightmodeler CLI</A>:
        it runs the same replay-and-judge loop on your own traces today, one
        command to start, and a skill lets your coding agent drive it. The agent
        takes that loop and gives it a calendar: the weekly catalog and price
        check, a daily drift check on new traces whose proposals a person
        approves, one regression replay for each merged swap set, and follow-up
        on swap pull requests as review and CI report back. It lives in the same
        MIT-licensed repository, and you can self-host it; the hosted version
        has a waitlist on <A href="/agent">the agent page</A>, and we will send
        one note when it opens.
      </P>

      <P>
        For now, rightmodeler validates swaps to cheaper models only; an
        upgrade, or a model at the same price, is still a call you make by hand.
        A person also sets the policy, gives the agent the word before it
        replays a new candidate, and is the only one who merges a draft pull
        request. That part is deliberate: autonomy is earned with evidence, and
        validation is how rightmodeler earns it.
      </P>

      <P>
        Next Tuesday, when the group chat asks whether you are switching, nobody
        has to find two spare days. Give the agent the word, and the answer
        comes back as a draft pull request with the receipts attached, or as a
        report that says why not. Today, the final yes stays yours.
      </P>

      <P>
        This is part two of the vision. Part one is about seeing: why your agent
        bill has no line items, and what{" "}
        <A href="/blog/the-bill-nobody-can-read">
          Crucible is being built to do about it
        </A>
        . Part three,{" "}
        <A href="/blog/the-job-nobody-can-staff">The job nobody can staff</A>,
        is about the work itself: why it is the bottleneck, what safe has to
        mean, and where all of this goes.
      </P>
    </Prose>
  );
}

// Kept in sync with Body above by hand.
export const markdown = `# The Tuesday problem.

The new model dropped on a Tuesday, because they always seem to drop on a Tuesday. By ten the group chat was a wall of benchmark screenshots. By quarter past, someone had asked the only question that matters: so, are we switching? And then everyone went quiet and looked at the one engineer who owns the model configs.

If you run agents in production, you know that silence. It is the sound of a person doing bad math quickly. Because the honest answer to "are we switching" is a project, and everyone in the chat knows nobody budgeted for it.

## Both options are bad

Done properly, the evaluation looks like this. Pull a few hundred real traces. Build a harness to replay them through the new model, step by step, with the same context. Judge the outputs against what you already shipped, carefully, because eyeballing is how regressions sneak through. Price the whole thing at your real token mix, not the launch table's. Write it up so the swap survives review. That is two days if the harness already exists, and closer to a week if it does not. And the next model lands in three weeks, so you get to do it all again.

The alternative is what most teams actually do: nothing. Keep paying yesterday's price for yesterday's model and tell yourself you will evaluate next sprint. Or worse, swap on vibes because the timeline was excited, and find out from a user which edge cases got worse.

We spent years on that treadmill ourselves; the [founding story](https://www.rightmodeler.com/blog/why-we-built-rightmodeler) is mostly about it. The arithmetic is uncomfortable. The price spread across plausible candidates can be large, and an over-provisioned step keeps burning money on every call, every retry, every user, every day, for exactly as long as the evaluation stays unscheduled. Skipping the question does not make it free. It makes it compound. And it cuts the other way too: a new release may perform better at a similar price, so declining to evaluate it can also leave quality on the table.

> Evaluating one model once is a project. Evaluating every model forever is a job.

## A cadence problem, not a judgment problem

Engineers are not bad at the judgment part. Given the replays, the scores, and the deltas, most teams make the right call in minutes. What breaks people is the cadence. A frontier release every few weeks, multiplied by every step in your stack, multiplied by every provider, is not a task you finish. It is a standing job. And standing jobs with clear inputs, checkable evidence, and a crisp definition of done are exactly the jobs we hand to software.

Put plainly, we think the biggest bottleneck in maintaining software is the human in the loop: not the judgment, the work. The work is everything before the call: noticing the release, building the replay, grading the outputs, writing it up, and migrating, every few weeks, forever. rightmodeler takes that work out of the loop, not the judgment.

## A cheaper or newer model swap should be a pull request

So here is the shape of it. [rightmodeler agent](https://www.rightmodeler.com/agent) runs a weekly catalog and price check that flags cheaper new or repriced models for the steps in your stack. On your word, it replays those candidates on your recorded traces, offline, and a judge from a different vendor, or your own evaluator, grades every answer against the output you already accepted. It works inside the policy you set: your quality floor, the shortlist size, the models it may and may not try, and an optional spend cap.

The bar is every release gate: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness.

When a candidate clears every gate, the agent opens a draft pull request in your repo. The diff changes only model identifiers. Attached to it are the receipts: the lower bound, the cost per case for the recorded model and the candidate, the sample size, and case IDs for the replays behind it. Your Tuesday shrinks to the part you were always good at: the judgment. You read the evidence, maybe spot-check a trace, and merge or close. The agent never merges and carries no merge capability.

And when no candidate clears every gate, there is no pull request. When the evidence is thin, the agent abstains and names the reason, exactly like the engine it is built on, because a tool that always finds a swap is not measuring anything.

## Today, and next Tuesday

The engine is the [rightmodeler CLI](https://github.com/elm-os/rightmodeler): it runs the same replay-and-judge loop on your own traces today, one command to start, and a skill lets your coding agent drive it. The agent takes that loop and gives it a calendar: the weekly catalog and price check, a daily drift check on new traces whose proposals a person approves, one regression replay for each merged swap set, and follow-up on swap pull requests as review and CI report back. It lives in the same MIT-licensed repository, and you can self-host it; the hosted version has a waitlist on [the agent page](https://www.rightmodeler.com/agent), and we will send one note when it opens.

For now, rightmodeler validates swaps to cheaper models only; an upgrade, or a model at the same price, is still a call you make by hand. A person also sets the policy, gives the agent the word before it replays a new candidate, and is the only one who merges a draft pull request. That part is deliberate: autonomy is earned with evidence, and validation is how rightmodeler earns it.

Next Tuesday, when the group chat asks whether you are switching, nobody has to find two spare days. Give the agent the word, and the answer comes back as a draft pull request with the receipts attached, or as a report that says why not. Today, the final yes stays yours.

This is part two of the vision. Part one is about seeing: why your agent bill has no line items, and what [Crucible is being built to do about it](https://www.rightmodeler.com/blog/the-bill-nobody-can-read). Part three, [The job nobody can staff](https://www.rightmodeler.com/blog/the-job-nobody-can-staff), is about the work itself: why it is the bottleneck, what safe has to mean, and where all of this goes.
`;
