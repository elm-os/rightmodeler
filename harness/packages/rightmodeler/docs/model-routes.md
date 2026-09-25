# Model routes

Replay sends each recorded request to cheaper candidate models, and the built-in judge grades every answer against the recorded one. Candidates and the judge each run on a route: an API endpoint with a key, or a plan you are signed in to on this machine through its command-line tool.

## Routes

- `--route api` sends candidate calls to the `--base-url` endpoint with the key named by `--api-key-env`. It is the default when `--base-url` is given, so commands from earlier releases behave as before.
- `--route claude-login` runs candidate calls through the `claude` CLI you are signed in to, under your Claude plan.
- `--route codex-login` runs candidate calls through the `codex` CLI you are signed in to, under your ChatGPT plan.
- `--judge-route api`, `--judge-route claude-login` or `--judge-route codex-login` picks where the built-in judge runs. With `--base-url` and no route flag, the judge uses the API route too.

The judge must come from a vendor other than both the candidate's and the recorded model's. A plan route serves one vendor's models, so a plan `--route` needs an explicit `--judge-route`; without one, rightmodeler stops with `invalid_option`. Candidates from the judge route's own vendor are left out with the warning `judge_vendor_candidates_dropped`, and the run stops before any model call with `no_neutral_judge` when no candidate is left or the recorded model comes from the judge's vendor.

`--base-url`, `--api-key-env` and `--header` configure the API route, so they are refused when both `--route` and `--judge-route` name a plan route. `--detach` and `--modeb-config` are refused when either role uses a plan route: detached replay and Mode B confirmation call models only through an API endpoint. `--evaluator` works with every route; the built-in judge on `--judge-route` grades when the evaluator is unreachable.

```sh
npx rightmodeler init --traces traces.jsonl --route claude-login --judge-route api --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY
npx rightmodeler init --traces traces.jsonl --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY --catalog-reference https://ai-gateway.vercel.sh/v1/models --judge-route claude-login
npx rightmodeler init --traces traces.jsonl --route codex-login --judge-route claude-login
```

## Use your Claude plan

`--route claude-login` and `--judge-route claude-login` run the `claude` CLI (Claude Code) already installed and signed in on this machine, version 2.1.282 or newer. Rightmodeler runs your own unmodified binary as a child process under the login it already holds. It never reads, stores or forwards a token, and never opens `~/.claude`, the macOS Keychain or a credential file.

Before any model call, rightmodeler runs `claude --version` and `claude auth status`. It accepts only a Claude plan login: signed in, through Anthropic directly, with a claude.ai login or a `claude setup-token` token. Anything else, such as an API key, Amazon Bedrock or Google Vertex, stops with `plan_login_required`.

Each call runs in a fresh, empty temporary directory with no tools, no MCP servers, no settings files, no skills, no auto memory, no session file and one turn: `claude -p --model <id> --system-prompt-file <file> --tools "" --strict-mcp-config --disable-slash-commands --setting-sources "" --no-session-persistence --max-turns 1 --settings {"switchModelsOnFlag":false} --output-format stream-json --verbose`, with the recorded user message on standard input. Because no session file is written, replays never appear in the Claude Code transcripts rightmodeler reads as traces.

An API key variable would make `claude` bill the key instead of your plan: in non-interactive mode the key is always used when present. Rightmodeler removes every `ANTHROPIC_*` and `OPENAI_*` variable, `CODEX_API_KEY`, and the variables of a parent Claude Code session from the child's environment, and warns with `plan_route_key_withheld` when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` was set, naming the variable and never its value. It keeps `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR`. If `claude` still reports that a call would be paid by a key, rightmodeler stops that call at once with `plan_login_required`.

Rightmodeler runs at most `--max-concurrency` `claude` processes at a time (default 2) and stops any still running when it exits. It refuses plan routes when the `CI` environment variable is set: a plan is for your own machine, not for continuous integration.

## Use your ChatGPT plan through Codex

`--route codex-login` and `--judge-route codex-login` run the `codex` CLI already installed and signed in on this machine, version 0.153.3 or newer. As with Claude, rightmodeler runs your own unmodified binary under the login it already holds.

- What runs: `codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check --sandbox read-only`, in a fresh, empty temporary directory, with the recorded system and developer messages in a temporary instructions file (`model_instructions_file`), the recorded user message on standard input, and settings that turn off the shell and other tools, web search, apps, plugins, skills, memories, the injected permission, app and environment context, project instructions and history. Code execution is off too (`features.code_mode_host=false`). `--ephemeral` keeps the session file out of `~/.codex/sessions`, where rightmodeler reads Codex traces, and `--ignore-user-config` keeps your `config.toml`, MCP servers and plugins out of the call. `--strict-config` makes a newer `codex` that renamed one of these settings stop with `plan_cli_unavailable` instead of quietly turning a tool back on.
- What it never touches: `auth.json`, the keyring or any token. Rightmodeler picks the credential store by name (`file`, else `keyring`) from what `codex login status` reports, and passes that name to each call. `CODEX_API_KEY`, every `OPENAI_*` and every `ANTHROPIC_*` variable are kept away from `codex`, and `plan_route_key_withheld` names a set `CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_FEDERATION_RULE_ID` or `OPENAI_IDENTITY_TOKEN_FILE`, never its value. `CODEX_HOME` and `CODEX_ACCESS_TOKEN` are passed through unread. A login with an API key, workload identity or Amazon Bedrock stops with `plan_login_required`, because it would not use your ChatGPT plan.
- What a Codex route measures: Codex adds about 2,000 input tokens of its own context to each call. That includes your global instructions file, `$CODEX_HOME/AGENTS.md` (or `AGENTS.override.md`), which Codex always adds and cannot be told to leave out; rightmodeler checks only that the file exists, never reads it, and warns once with `codex_global_instructions`. Cost estimates use the recorded input tokens, so this context does not change the savings. Codex cannot set temperature or an output limit, and each model runs at its default reasoning effort, as on the API route, which sends none.
- What Codex does not report: which model answered. Rightmodeler records the requested model, and leaves a call out of the evidence when Codex reports that it rerouted the call to another model.
- Tools: Codex keeps a code tool and a patch tool registered that no setting removes, so a call can include a tool step its output does not show. A call where Codex reports a tool step is left out of the evidence. In rightmodeler's check on `codex-cli` 0.153.3 on 2026-09-25, a prompt asking the model to read a file with its code tool used 13,325 input tokens with code execution on and 3,826 with it off, and neither output showed the tool step; with code execution off, the model answered that it could not run anything.
- Models: the list comes from `codex debug models` of the same binary that makes the calls, so update Codex to see newer models. GPT-5.5 retires from ChatGPT sign-in on October 14, 2026; it stays on the OpenAI API.
- Limits: a limit on one model blocks that candidate, or moves the judge to its next model. An account usage limit, a workspace out of credits or a spend cap starts no new call and exits `2` with `plan_usage_limit`, quoting Codex's reset time as Codex wrote it. Rerun after the reset: finished calls are kept. `codex exec` reports no remaining allowance, so rightmodeler cannot warn before the limit.
- Concurrency: at most `--max-concurrency` `codex` processes run at a time (default 2), each stopped when rightmodeler exits. Plan routes are refused when `CI` is set.

## What a plan route measures

A plan route measures the model inside a coding CLI, not the API request your application makes:

- Claude Code adds its own instructions to every call, even when rightmodeler replaces the system prompt: 380 to 539 input tokens in testing, including the signed-in account's email address and today's date.
- The CLI cannot set temperature or an output limit, so the recorded values are not applied, and an answer can be longer than on the API route.
- It sends one user turn. Recorded cases with an earlier assistant or tool turn, or more than one user message, are left out of the replay sample with the warning `plan_route_cases_left_out`.
- Latency is the API time the CLI reports, without its start-up time.
- Rightmodeler checks which model answered on every call, and records a substitution when `claude` answers with another model, takes more than one turn or calls a tool.

The report's "Model routes" section, and the pull request that `apply` opens, say when a result was measured through a plan.

Your recorded prompts are sent to Anthropic under your plan account's data settings. Anthropic's data-usage page says: "We will train new models using data from Free, Pro, and Max accounts when this setting is on (including when you use Claude Code from these accounts)" (`https://code.claude.com/docs/en/data-usage`).

## Costs, the cap and usage limits

Calls through a plan are not billed in dollars: they use your plan's usage allowance, the same 5-hour and weekly limits as your own Claude Code sessions. To budget and compare them, rightmodeler prices each call at API list prices from a public price list, `https://ai-gateway.vercel.sh/v1/models`, read without a key. `--catalog-reference <url-or-path>` replaces that list, including with a local file when the public list is unreachable. `--pricing-file` only overrides the prices of the ids it names.

A call's cost is the recorded request's input tokens plus the output tokens the CLI reports, at list price, and is always marked as an estimate. The CLI's added instructions stay out of it, so savings compare with the recorded calls. The report and `estimate` label these amounts as list-price equivalents and show dollars billed through an API route separately.

Plan routes have no default limit on calls or spend: a run makes as many calls as it needs, and the vendor's own usage limit is the only stop (the run resumes after the reset). `--max-cost-usd` is optional; when you set it on a plan route it caps the list-price equivalent, as a soft cap: the CLI sets no output limit, so a call can cost more than its reservation.

When `claude` reports your plan near its limit, rightmodeler warns once with `plan_usage_warning`, giving the share used and the reset time. When the plan reaches its limit, or further calls would bill usage credits (`credits_required`, or `claude` reporting overage), rightmodeler starts no new call and exits `2` with `plan_usage_limit`, quoting the reset time. Calls already running finish and are kept, so up to `--max-concurrency` calls can still use credits when overage begins. Rerun the same command after the reset: finished replay and judge calls are reused.

Anthropic announced, then paused, a change that would take `claude -p` usage off your plan's limits and onto a monthly credit, then usage credits (`https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`). For now, the page says, `claude -p` still draws from your subscription's usage limits. If the change takes effect, rightmodeler stops at `credits_required` or overage as described above.

Rightmodeler leaves out Claude Fable models, because in non-interactive mode "When a Fable request there would bill to usage credits, Claude Code bills it without asking" (`https://code.claude.com/docs/en/model-config`), and `[1m]` variants, whose 1M context can require usage credits. Models the price list does not price are left out with `plan_model_unpriced`.

## Errors

- `plan_cli_unavailable` (exit `2`): `claude` is missing or older than 2.1.282, `codex` is missing or older than 0.153.3, `CI` is set, the CLI changed an output shape rightmodeler relies on, or `codex` rejected one of rightmodeler's isolation settings.
- `plan_login_required` (exit `2`): `claude` is not signed in with a Claude plan, `codex` is not signed in with ChatGPT, the CLI would use an API key, or it lost its login during the run.
- `plan_usage_limit` (exit `2`): the plan reached its usage limit.
- `no_neutral_judge` and `judge_family_unknown` (exit `2`): no judge from a third vendor is available. See [Exit codes](exit-codes.md).

## Terms

Anthropic's legal page says OAuth authentication "is designed to support ordinary use of Claude Code and other native Anthropic applications", that third-party developers may not "route requests through Free, Pro, or Max plan credentials on behalf of their users", and that this does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription" (`https://code.claude.com/docs/en/legal-and-compliance`). The Agent SDK page adds: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products" (`https://code.claude.com/docs/en/agent-sdk/overview`). Anthropic's Consumer Terms restrict access "through automated or non-human means, whether through a bot, script, or otherwise" except "where we otherwise explicitly permit it" (`https://www.anthropic.com/legal/consumer-terms`).

OpenAI's non-interactive guide says "`codex exec` reuses saved CLI authentication by default." and "API keys are the right default for automation because they are simpler to provision and rotate. Use this path only if you specifically need to run as your Codex account." (`https://learn.chatgpt.com/docs/non-interactive-mode`). OpenAI's pricing page lists "Codex SDK, `codex exec`, and scriptable workflows" as available on Plus, Pro, Business and Enterprise (`https://learn.chatgpt.com/docs/pricing`). OpenAI's Terms of Use list "Automatically or programmatically extract data or Output" among what you may not do (`https://openai.com/policies/terms-of-use/`). OpenAI's CI guide says "Do not use this workflow for public or open-source repositories" about seeding `auth.json` on CI runners (`https://learn.chatgpt.com/docs/auth/ci-cd-auth`).

Refusing plan routes when `CI` is set is rightmodeler's own product choice: a plan route is local and opt-in. Rightmodeler runs on your machine, for you, with your own unmodified `claude` or `codex` and your own login, and never handles a credential. Whether a replay fits your plan's terms is your decision; the API route is always available.
