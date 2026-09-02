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

See [Commands](commands.md) for where `--modeb-config` is accepted and [Exit codes](exit-codes.md) for blocked or failed runs.
