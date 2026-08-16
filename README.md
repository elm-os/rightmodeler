# rightmodeler

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

rightmodeler proves, from your own agent traces, where a cheaper model can replace
an expensive one without breaking quality. It is open source under the MIT license.

## Install the skill

```bash
npx skills add elm-os/rightmodeler --skill rightmodeler
```

Then invoke `rightmodeler` in your coding agent.

The skill is the runbook for the installed TypeScript CLI. It drives the resumable
pipeline from ingest through report generation and interprets its machine protocol.

## Run the CLI

Start in the repository you want to analyze:

```bash
npx rightmodeler init
```

Rightmodeler looks for trace logs in conventional project files and in Claude Code
and Codex session stores for the current repository. In an interactive terminal it
explains traces, lists what it found, and lets you choose a file. Automated runs
should keep passing `--traces <path>` explicitly.

Replay needs an OpenAI-compatible endpoint and an API key already exported in your
shell. Pass the endpoint with `--base-url`. The key variable defaults to
`RIGHTMODELER_API_KEY`; use `--api-key-env <name>` when your key is stored under a
different variable.

```bash
export RIGHTMODELER_API_KEY=your_key_here
npx rightmodeler init --base-url https://provider.example/v1
```

The CLI never asks for the key value and never reads a secret from standard input.
It names missing input at a resumable boundary so the same command can continue
from completed checkpoints.

Before replaying models, project the maximum candidate spend from recorded token
usage and the endpoint's current model catalog:

```bash
npx rightmodeler estimate \
  --traces /path/to/traces.json \
  --base-url https://provider.example/v1
```

## What it does

- Ingests trace logs from supported agent runtimes
- Maps your pipeline step by step
- Replays candidate cheaper models against your accepted outputs
- Flags cascade risk and abstains when the evidence is weak
- Writes working artifacts under `.rightmodeler/`

## Contributing

Contributions are welcome. [CONTRIBUTING.md](.github/CONTRIBUTING.md) covers the
setup, the workspace layout, the commands, and the pull request conventions.

The canonical skill source lives in `skills/rightmodeler`. Do not edit generated
copies under `.agents/skills/` or `.claude/skills/`.

To report a security issue, follow [SECURITY.md](.github/SECURITY.md) rather than
opening a public issue. Participation is governed by our
[Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Generated artifacts

Pipeline and skill outputs live under `.rightmodeler/`.

Expected layout:

```text
.rightmodeler/
├── input/
├── normalized/
├── analysis/
└── reports/
```

This directory is the TypeScript harness state and artifact boundary.

## License

MIT. See [LICENSE](LICENSE).
