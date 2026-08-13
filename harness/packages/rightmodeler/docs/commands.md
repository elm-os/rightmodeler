# Commands

This file is generated from the CLI definitions. Run `pnpm docs:generate` after changing a command.

See [Getting started](getting-started.md) for the shortest complete workflow and [Exit codes](exit-codes.md) for automation behavior.

## `rightmodeler`

```text
Usage: rightmodeler [options] [command]

Find and prove safe model substitutions.

Options:
  -V, --version        output the version number
  --repo <dir>         repository to analyze (default:
                       ".")
  --store <dir>        store directory
  --output <mode>      output mode (choices: "human", "json", "jsonl", default:
                       "human")
  -h, --help           display help for command

Commands:
  init [options]       run the resumable Phase A pipeline
  scan [options]       run through the scan stage
  ingest [options]     run through the ingest stage
  reconcile [options]  run through the reconcile stage
  scrub [options]      run through the scrub stage
  shortlist [options]  run through the shortlist stage
  replay [options]     run through the replay stage
  aggregate [options]  run through the aggregate stage
  confirm [options]    run through the confirm stage
  corpus [options]     build or import the replay corpus
  export [options]     export trials and verdicts to an evaluation provider
  audit                manage the reference audit
  apply [options]      open a draft pull request for proven model swaps
  watch [options]      reconcile one open model-swap pull request
  report               write report.md and report.json
  status               summarize the current store
  help [command]       display help for command
```

## `rightmodeler init`

```text
Usage: rightmodeler init [options]

run the resumable Phase A pipeline

Options:
  --traces <path>                     trace input file
  --modeb-config <path>               versioned Mode B runtime configuration
                                      JSON file
  --base-url <url>                    OpenAI-compatible provider base URL
  --api-key-env <name>                environment variable containing the
                                      provider API key
  --max-cost-usd <amount>             maximum replay spend in USD
  --evaluator <provider>              external evaluator provider (choices:
                                      "braintrust", "langfuse", "langsmith",
                                      "promptfoo")
  --evaluator-base-url <url>          external evaluator API base URL
  --evaluator-api-key-env <name>      environment variable containing the
                                      evaluator API key
  --evaluator-public-key-env <name>   environment variable containing the
                                      Langfuse public key
  --evaluator-project-id <id>         Braintrust project or LangSmith dataset
                                      identifier
  --evaluator-command <path>          promptfoo executable path or command
  --evaluator-config <path>           promptfoo assertions configuration file
  --evaluator-scorer <name>           external evaluator scorer name
                                      (repeatable)
  --evaluator-gate-metric <name>      scorer metric used for release gates
  --evaluator-gate-threshold <value>  fallback pass threshold when the evaluator
                                      omits a pass decision
  --plan                              print stage states without executing
  --through <stage>                   stop after this stage (choices: "scan",
                                      "ingest", "reconcile", "scrub", "corpus",
                                      "audit-sample", "shortlist", "replay",
                                      "aggregate", "confirm", "report")
  --yes                               accept defaults (reserved for future
                                      prompts)
  -h, --help                          display help for command
```

## `rightmodeler scan`

```text
Usage: rightmodeler scan [options]

run through the scan stage

Options:
  --traces <path>        trace input file
  --modeb-config <path>  versioned Mode B runtime configuration JSON file
  -h, --help             display help for command
```

## `rightmodeler ingest`

```text
Usage: rightmodeler ingest [options]

run through the ingest stage

Options:
  --traces <path>        trace input file
  --modeb-config <path>  versioned Mode B runtime configuration JSON file
  -h, --help             display help for command
```

## `rightmodeler reconcile`

```text
Usage: rightmodeler reconcile [options]

run through the reconcile stage

Options:
  --traces <path>        trace input file
  --modeb-config <path>  versioned Mode B runtime configuration JSON file
  -h, --help             display help for command
```

## `rightmodeler scrub`

```text
Usage: rightmodeler scrub [options]

run through the scrub stage

Options:
  --traces <path>        trace input file
  --modeb-config <path>  versioned Mode B runtime configuration JSON file
  -h, --help             display help for command
```

## `rightmodeler shortlist`

```text
Usage: rightmodeler shortlist [options]

run through the shortlist stage

Options:
  --traces <path>        trace input file
  --modeb-config <path>  versioned Mode B runtime configuration JSON file
  -h, --help             display help for command
```

## `rightmodeler replay`

```text
Usage: rightmodeler replay [options]

run through the replay stage

Options:
  --traces <path>                     trace input file
  --modeb-config <path>               versioned Mode B runtime configuration
                                      JSON file
  --base-url <url>                    OpenAI-compatible provider base URL
  --api-key-env <name>                environment variable containing the
                                      provider API key
  --max-cost-usd <amount>             maximum replay spend in USD
  --evaluator <provider>              external evaluator provider (choices:
                                      "braintrust", "langfuse", "langsmith",
                                      "promptfoo")
  --evaluator-base-url <url>          external evaluator API base URL
  --evaluator-api-key-env <name>      environment variable containing the
                                      evaluator API key
  --evaluator-public-key-env <name>   environment variable containing the
                                      Langfuse public key
  --evaluator-project-id <id>         Braintrust project or LangSmith dataset
                                      identifier
  --evaluator-command <path>          promptfoo executable path or command
  --evaluator-config <path>           promptfoo assertions configuration file
  --evaluator-scorer <name>           external evaluator scorer name
                                      (repeatable)
  --evaluator-gate-metric <name>      scorer metric used for release gates
  --evaluator-gate-threshold <value>  fallback pass threshold when the evaluator
                                      omits a pass decision
  -h, --help                          display help for command
```

## `rightmodeler aggregate`

```text
Usage: rightmodeler aggregate [options]

run through the aggregate stage

Options:
  --traces <path>        trace input file
  --modeb-config <path>  versioned Mode B runtime configuration JSON file
  -h, --help             display help for command
```

## `rightmodeler confirm`

```text
Usage: rightmodeler confirm [options]

run through the confirm stage

Options:
  --traces <path>                     trace input file
  --modeb-config <path>               versioned Mode B runtime configuration
                                      JSON file
  --base-url <url>                    OpenAI-compatible provider base URL
  --api-key-env <name>                environment variable containing the
                                      provider API key
  --max-cost-usd <amount>             maximum replay spend in USD
  --evaluator <provider>              external evaluator provider (choices:
                                      "braintrust", "langfuse", "langsmith",
                                      "promptfoo")
  --evaluator-base-url <url>          external evaluator API base URL
  --evaluator-api-key-env <name>      environment variable containing the
                                      evaluator API key
  --evaluator-public-key-env <name>   environment variable containing the
                                      Langfuse public key
  --evaluator-project-id <id>         Braintrust project or LangSmith dataset
                                      identifier
  --evaluator-command <path>          promptfoo executable path or command
  --evaluator-config <path>           promptfoo assertions configuration file
  --evaluator-scorer <name>           external evaluator scorer name
                                      (repeatable)
  --evaluator-gate-metric <name>      scorer metric used for release gates
  --evaluator-gate-threshold <value>  fallback pass threshold when the evaluator
                                      omits a pass decision
  -h, --help                          display help for command
```

## `rightmodeler corpus`

```text
Usage: rightmodeler corpus [options] [command]

build or import the replay corpus

Options:
  --traces <path>        trace input file
  --modeb-config <path>  versioned Mode B runtime configuration JSON file
  -h, --help             display help for command

Commands:
  import [options]       import a curated provider dataset
```

## `rightmodeler corpus import`

```text
Usage: rightmodeler corpus import [options]

import a curated provider dataset

Options:
  --from <provider:dataset>  provider and dataset
  --base-url <url>           dataset provider API base URL
  --api-key-env <name>       environment variable containing the dataset
                             provider API key
  --public-key-env <name>    environment variable containing the Langfuse public
                             key
  -h, --help                 display help for command
```

## `rightmodeler export`

```text
Usage: rightmodeler export [options]

export trials and verdicts to an evaluation provider

Options:
  --to <provider>          result sink provider (choices: "braintrust",
                           "langfuse")
  --base-url <url>         result sink API base URL
  --api-key-env <name>     environment variable containing the result sink API
                           key
  --public-key-env <name>  environment variable containing the Langfuse public
                           key
  --project-id <id>        Braintrust project identifier
  --dataset-id <id>        Langfuse dataset identifier
  -h, --help               display help for command
```

## `rightmodeler audit`

```text
Usage: rightmodeler audit [options] [command]

manage the reference audit

Options:
  -h, --help          display help for command

Commands:
  sample [options]    write the audit worksheet without blocking
  tabulate [options]  tabulate a completed audit worksheet
  help [command]      display help for command
```

## `rightmodeler audit sample`

```text
Usage: rightmodeler audit sample [options]

write the audit worksheet without blocking

Options:
  --traces <path>        trace input file
  --modeb-config <path>  versioned Mode B runtime configuration JSON file
  -h, --help             display help for command
```

## `rightmodeler audit tabulate`

```text
Usage: rightmodeler audit tabulate [options]

tabulate a completed audit worksheet

Options:
  --worksheet <path>  completed worksheet JSON file
  -h, --help          display help for command
```

## `rightmodeler apply`

```text
Usage: rightmodeler apply [options]

open a draft pull request for proven model swaps

Options:
  --owner <owner>            GitHub repository owner
  --github-base-url <url>    GitHub API base URL
  --github-token-env <name>  environment variable containing the GitHub token
  --dry-run                  run all machine gates without writing GitHub state
  -h, --help                 display help for command
```

## `rightmodeler watch`

```text
Usage: rightmodeler watch [options]

reconcile one open model-swap pull request

Options:
  --owner <owner>            GitHub repository owner
  --pr <number>              pull request number
  --github-base-url <url>    GitHub API base URL
  --github-token-env <name>  environment variable containing the GitHub token
  -h, --help                 display help for command
```

## `rightmodeler report`

```text
Usage: rightmodeler report [options]

write report.md and report.json

Options:
  -h, --help  display help for command
```

## `rightmodeler status`

```text
Usage: rightmodeler status [options]

summarize the current store

Options:
  -h, --help  display help for command
```
