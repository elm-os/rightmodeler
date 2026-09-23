# Mode B configuration

Mode B runs confirmation cases inside a container when a recommendation can affect downstream model-authored steps. Pass a JSON file with `--modeb-config`.

```json
{
  "version": "1",
  "image": "my-agent:latest",
  "backend": "docker",
  "appSpec": {
    "mountPath": ".",
    "command": ["node", "/rightmodeler/app/driver.mjs", "{caseFile}"],
    "installCommand": ["pnpm", "install", "--offline"]
  },
  "stepMap": {
    "canonical-step-id": "runtime-step-header"
  },
  "confirmMaxRunSets": 20
}
```

## Contract

- `version` must be the string `"1"`.
- `image` is the non-empty container image name.
- `appSpec.mountPath` is resolved relative to the configuration file and mounted read-only at `/rightmodeler/app`.
- `appSpec.command` is a non-empty array of non-empty arguments. At least one argument must contain `{caseFile}`; the harness replaces every occurrence with the in-container case file path.
- `appSpec.installCommand` is optional. When present, it is a non-empty array of non-empty arguments run before the workload.
- `stepMap` maps at least one canonical scanner step ID to the runtime step header emitted by the application. Runtime headers must be unique.
- `backend` is optional and is either `"docker"` (the default) or `"cloud"`. The cloud backend runs each case in a remote sandbox, so `image` must name an image that sandbox platform can pull, and the run fails before any case starts when the sandbox SDK or its credentials are absent.
- `confirmMaxRunSets` is optional and must be a non-negative integer.

## Runtime contract

- The container receives `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`, a placeholder `OPENAI_API_KEY`, and the `RM_RUN_ID`, `RM_CASE_ID`, and `RM_EXECUTION_ID` identifiers.
- `/rightmodeler/scratch/driver/case.json` contains `{ "caseId", "input", "headers"? }`. The `headers` field is omitted when the case has no headers.
- Every model request must carry `x-rm-step` exactly once. Its value is the runtime step header selected through `stepMap`.
- Every model request must carry `x-rm-call`. Use one ID per logical call and reuse that ID when the SDK retries the call.
- The request body must be a JSON object with a non-empty `model` string.
- On a step the candidate does not replace, the request must name that step's current model by the id the provider catalog lists for it. The proxy holds prices only for the models the run's steps call, so a request for any other model is recorded as lost with `missing_pricing` and never forwarded.
- `max_completion_tokens` or `max_tokens` is accepted when present. When both are absent, the proxy reserves against the catalog maximum output when known, or 4096 tokens otherwise, and does not add a limit to the forwarded body.
- Streamed requests are sent with `stream_options.include_usage: true` and metered from the trailing usage chunk. A stream without a usage chunk is charged at its reservation.
- The last non-empty stdout line must be `{ "runId", "caseId", "executionId", "finalOutput" }`.
- A request is recorded as lost and never forwarded for `missing_correlation`, `duplicate_step_correlation`, `request_too_large` at 10 MiB, `malformed_json`, `invalid_request`, or `missing_pricing`.
- A case with any lost request is a lost execution. Lost reason counts are reported on the Mode B result.
- A request that the case lease cannot cover receives HTTP 402. The case is blocked on budget without an execution fact and is retried on rerun.
- If the host cannot observe a container exit within the configured timeout plus ten seconds, it force-removes the container and records the case as lost under `container_lifecycle`.
- The `docker` CLI must reach the Docker daemon. A missing daemon, a failed egress listener, or a failed container launch blocks affected cases with a named reason instead of recording executions, so a rerun retries them.
- The in-container proxy runs on both backends. The workload always reaches it at `OPENAI_BASE_URL`, and it meters the case lease and records every attempt. Only the hop after it differs: the Docker backend forwards to a host listener over `host.docker.internal`, while the cloud backend forwards straight to the provider and the sandbox platform's egress firewall attaches the model credential in flight. The credential never enters the sandbox on either backend.
- The workload is killed at the configured timeout by both the host and an in-container deadline.

## Cloud backend

- The cloud backend runs each confirmation case in a short-lived Vercel Sandbox microVM in your own Vercel project. It is separate from the Vercel AI Gateway: the `VERCEL_*` variables only authorize creating sandboxes, and the model credential is always the variable named by `--api-key-env`, whatever the provider.
- Install: `npx rightmodeler` installs `@vercel/sandbox` as an optional dependency. Installing with `--omit=optional` leaves it out; the CLI still runs and the cloud backend reports `modeb_cloud_unavailable`.
- Credentials: either `VERCEL_OIDC_TOKEN` (from `vercel link` then `vercel env pull`; it expires after 12 hours) or all of `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. Use the access token in CI.
- Image: `image` must be a Vercel Container Registry reference or a managed image such as `vercel/sandbox/node:24`; a Docker Hub name does not work, and a custom image's entrypoint and command do not run. Commands run as the image's default user, which is not root (`ubuntu` on `vercel/sandbox/node:24`). An image the platform cannot start blocks its case with `launch-failed`, so a rerun retries it.
- Provider: the base URL must be HTTPS, because the sandbox firewall matches the provider host by TLS server name before it attaches the credential. Its path is kept, so a base URL such as `https://openrouter.ai/api/v1` reaches the same endpoints as on the Docker backend.
- Credential handling: the firewall adds the model credential to requests for the provider host only, and its policy lets every other host through, so this is credential brokering, not an egress allowlist.
- Metering: the in-sandbox proxy asks the provider for uncompressed responses so it can read usage from every answer. There is no host listener to mark answers of its own, so every HTTP answer is attributed to the provider, including one the platform firewall produces itself; a connection that fails is attributed to the network path and its case is recorded as a lost execution.
- Timing: the 60 second case deadline starts when the workload command starts and includes `appSpec.installCommand`; every case starts a fresh microVM, so bake dependencies into the image. The sandbox itself lives for the deadline plus 60 seconds, which also bounds how long an interrupted run can leave one running.
- Cleanup: sandboxes are created non-persistent and deleted after each case.
- Scoring: sandboxes never score. The host judges every case; sandbox output is only the candidate text.

See [Commands](commands.md) for where `--modeb-config` is accepted and [Exit codes](exit-codes.md) for blocked or failed runs.
