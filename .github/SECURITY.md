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

rightmodeler ships from `main`. Fixes land there, and the skill is re-installed from
source, so `main` is the only supported version.

## Scope

**In scope**

- The skill runtime in `skills/rightmodeler`
- The Python pipeline in `apps/pipeline`
- The schemas in `packages/contracts`
- www.rightmodeler.com and its API routes in `apps/web`

**Out of scope**

- Vulnerabilities in upstream model providers (OpenRouter, the Vercel AI Gateway,
  LiteLLM). Report those to the provider.
- Findings that require an attacker to already control the machine running the skill.
- Volumetric denial of service against the marketing site.

## How rightmodeler handles your credentials

Worth knowing before you test: the skill reads provider keys from your process
environment or a project `.env` in your own repo tree. It never asks you to send a key
value, never writes one for you, and never transmits one anywhere except to the
provider you configured. It runs offline against traces you already have and never sits
in your request path. If you find behavior that contradicts any of this, treat it as a
security issue and report it.
