# Security policy

## Reporting a vulnerability

Do not open a public issue for a security report.

Email **rightmodeler@gmail.com** with:

- What the issue is and where it lives (file, script, or endpoint)
- Steps to reproduce, or a proof of concept
- What an attacker could do with it

We will acknowledge your report within 5 business days and keep you updated as we
work on a fix. Once a fix ships we will credit you in the release notes unless you
would rather stay anonymous.

Please give us reasonable time to ship a fix before disclosing publicly.

## Supported versions

The rightmodeler CLI is published as versioned releases on npm. Fixes land on `main` and
go out in the next release, so the latest release published on npm and `main` are the
only supported versions. The skill installs from this repository; re-install it to pick up
changes.

## Scope

**In scope**

- The coding-agent skill in `skills/rightmodeler`
- The TypeScript CLI and harness in `harness`
- The schemas in `packages/contracts`
- www.rightmodeler.com and its API routes in `apps/web`

**Out of scope**

- Vulnerabilities in upstream model providers (OpenRouter, the Vercel AI Gateway,
  LiteLLM). Report those to the provider.
- Findings that require an attacker to already control the machine running the skill.
- Volumetric denial of service against the marketing site.

## How rightmodeler handles your credentials

Worth knowing before you test: the CLI reads a provider key from the environment
variable you name (`RIGHTMODELER_API_KEY` by default), and never takes the key as an
argument, prompts for it or loads it from a `.env` file. It never asks you to send a key
value, never writes one for you, and never transmits one anywhere except to the
provider you configured (on a cloud Mode B backend, by way of the sandbox platform's
egress firewall). It runs offline against traces you already have and never sits
in your request path. If you find behavior that contradicts any of this, treat it as a
security issue and report it.
