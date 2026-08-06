# rightmodeler

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

rightmodeler proves, from your own agent traces, where a cheaper model can replace
an expensive one without breaking quality. It is open source under the MIT license.

## Install the skill

```bash
npx skills add elm-os/rightmodeler --skill rightmodeler
```

Then invoke `rightmodeler` in your coding agent.

The skill is the execution layer. It installs the skill bundle, then drives the
repo's Python scripts for you: preflight, ingest, analyze, replay, judge, TUI,
and report generation.

Before first run, configure one replay provider. Only one setup is needed:

```env
# OpenRouter
OPENROUTER_API_KEY=your_key_here

# Vercel AI Gateway
AI_GATEWAY_API_KEY=your_key_here

# LiteLLM proxy
LITELLM_PROXY_API_BASE=https://your-proxy.example.com
LITELLM_PROXY_API_KEY=your_key_here
```

Set only the variables for the provider you use. If more than one complete setup
is present, the skill selects OpenRouter, then the Vercel AI Gateway, then LiteLLM.
To choose explicitly, optionally set `RIGHTMODELER_PROVIDER` to `openrouter`,
`vercel-ai-gateway`, or `litellm`.

Put the variables in your project root `.env`, or export them in your shell. You
set them yourself: the skill never asks you to send a key value and never writes
one for you. It checks the process environment first, then looks up the current
repo tree for a project `.env`.

On first run, `rightmodeler` should bootstrap its Python environment, run
preflight, name anything still missing such as an unset provider variable or a
trace path, then continue in the same workflow once you reply.

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

This directory is the current handoff boundary between the Python pipeline and the
rest of the repo.

## License

MIT. See [LICENSE](LICENSE).
