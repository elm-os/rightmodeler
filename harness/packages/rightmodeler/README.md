# Rightmodeler CLI

Find and prove safe model substitutions from the agent traces you already have. It
replays each step through cheaper models (by default those released in the last 90
days, or the ones you name), measures every output against the one you accepted,
reports the evidence and any abstentions, and ships approved swaps as a pull request
you can roll back byte for byte.

Documentation and guides: [rightmodeler.com](https://www.rightmodeler.com)

Start with [the packaged getting-started guide](docs/getting-started.md).

Published on npm as `rightmodeler`; inside this repository the workspace package is named
`@rightmodeler/cli` so it cannot collide with the repository root package.
