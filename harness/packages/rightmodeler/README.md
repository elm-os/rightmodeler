# rightmodeler CLI

Cheaper or newer model swaps for production AI, validated on your own traces and opened as draft PRs.

rightmodeler takes the work out of the loop, not the judgment. It is a validation framework
for model swaps: it reads the model calls your app already recorded, replays the recorded
steps on cheaper candidate models from your provider's live catalog (by default up to three
released in the last 90 days, or models you name with `--candidate` that cost less), and
has a judge from a different vendor, or your own evaluator, grade every answer against the
output you accepted. Replay sends recorded text conversations: cases whose conversation
carries tool calls, tool definitions or non-text parts are left out of the replay sample
today, and the run says how many. It abstains when the evidence is thin. A swap that clears
every release gate becomes a draft pull request that changes only model identifiers, with
the evidence attached, for a person to review and merge. `watch` follows the pull request
through review and CI, and `rollback` opens a pull request that restores the exact
pre-swap files.

It runs offline beside your app, on your machine or in CI, never in your app's request path,
with no rightmodeler server and no telemetry.

Documentation and guides: [rightmodeler.com](https://www.rightmodeler.com)

Start with [the packaged getting-started guide](docs/getting-started.md).

Published on npm as `rightmodeler`; inside this repository the workspace package is named
`@rightmodeler/cli` so it cannot collide with the repository root package.
