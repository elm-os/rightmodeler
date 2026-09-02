# rightmodeler agent

The offline build, discovery, and eval path requires no GitHub App or model credentials. Missing runtime configuration makes schedules log a skip instead of starting partial work.

## Model

The agent routes through the Vercel AI Gateway, so a production launch needs `AI_GATEWAY_API_KEY`, or `VERCEL_OIDC_TOKEN` from a linked Vercel project. Without one the first model call fails with a credentials error. The model id in `agent/agent.ts` is a swappable default, not a requirement: change it with `eve set --model <gateway-model-id>` from this directory, or edit the `model` field directly. Eval runs use a deterministic fixture model and need no credential.

## Runtime configuration

The GitHub channel reads `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and `GITHUB_APP_SLUG` lazily when a webhook reaches `/eve/v1/github`. `RIGHTMODELER_GITHUB_BOT_NAME` overrides the invocation token. Only comments from `COLLABORATOR`, `MEMBER`, or `OWNER` actors that mention the bot dispatch; agent replies carry an ignore marker.

The mounted GitHub tools read `GITHUB_TOKEN` for outbound API calls. The GitHub App variables authenticate the channel only and do not supply this token.

Schedules use these shared variables:

- `RIGHTMODELER_REPO`, with optional `RIGHTMODELER_STORE`
- `RIGHTMODELER_TRACES`, `RIGHTMODELER_PROVIDER_BASE_URL`, and optional `RIGHTMODELER_API_KEY_ENV`, `RIGHTMODELER_MAX_COST_USD`, `RIGHTMODELER_MODEB_CONFIG`. `RIGHTMODELER_MAX_COST_USD` bounds `price-decay` and `approved-regression`; when unset, the weekly regression replay runs uncapped
- `RIGHTMODELER_GITHUB_OWNER`, `RIGHTMODELER_GITHUB_REPO`, `RIGHTMODELER_GITHUB_REPORT_ISSUE`, and `RIGHTMODELER_GITHUB_INSTALLATION_ID`
- `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` for scheduled GitHub delivery
- Optional `RIGHTMODELER_GITHUB_API_BASE_URL` and `RIGHTMODELER_GITHUB_TOKEN_ENV` for `pr-watch`; with `RIGHTMODELER_GITHUB_OWNER`, these also default `open_swap_pr` and webhook-triggered watches. The variable named by `RIGHTMODELER_GITHUB_TOKEN_ENV` must contain the GitHub token. Watched pull requests are derived from the append-only lifecycle store
- `RIGHTMODELER_AGENT_STORE` is required for `replay-watch` and `approved-regression`; they record each handoff exactly once and skip loudly without it

Subscribe the GitHub App to `issue_comment`, `pull_request_review_comment`, `pull_request`, `check_suite`, and `workflow_run`. Add a second webhook URL at `/eve/v1/github-review` subscribed to `pull_request_review`. Both routes verify `GITHUB_WEBHOOK_SECRET`.

Set `RIGHTMODELER_AGENT_STORE` to persist supplemental append-only audit and agent-cost records under `<store>/agent/`. Agent-cost hooks record only model calls for which the provider reports `costUsd`; provider-boundary replay spend remains authoritative in the harness ledger.

`RIGHTMODELER_AGENT_STORE` must be a persistent mounted path. A serverless deployment's local filesystem is ephemeral, so leave the hooks loudly skipped unless the deployment supplies such a mount.

## Production launch

Detached replay starts a child process and both harness and hook state are filesystem-backed. Run the built agent on one long-lived Node 24 host under a process supervisor, with `RIGHTMODELER_STORE` and `RIGHTMODELER_AGENT_STORE` on a persistent mounted volume:

`replay-watch` runs every fifteen minutes and `approved-regression` runs weekly, so the host must be the same long-lived process that owns both stores.

```sh
pnpm --filter @rightmodeler/agent build && pnpm --filter @rightmodeler/agent exec eve start --host 0.0.0.0
```

The managed `eve deploy` target is not supported until detached work and both stores use durable external adapters.
