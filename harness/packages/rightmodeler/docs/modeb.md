# Mode B configuration

Mode B runs confirmation cases inside a container when a recommendation can affect downstream model-authored steps. Pass a JSON file with `--modeb-config`.

```json
{
  "version": "1",
  "image": "my-agent:latest",
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
- `confirmMaxRunSets` is optional and must be a non-negative integer.

See [Commands](commands.md) for where `--modeb-config` is accepted and [Exit codes](exit-codes.md) for blocked or failed runs.
