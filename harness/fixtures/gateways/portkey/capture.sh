#!/usr/bin/env bash
# The capture behind plain.json, override-params.json and input-mutator.json, run on 2026-09-23:
# portkeyai/gateway:1.15.2 in front of echo-upstream.mjs, sending the same request once per
# configuration. Writes each response's headers and body to the directory given as the first
# argument, or to a new temporary directory.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CAP=${1:-$(mktemp -d)}
echo "CAP=$CAP"
docker pull portkeyai/gateway:1.15.2 2>&1 | tail -2
docker image inspect --format '{{json .RepoDigests}}' portkeyai/gateway:1.15.2
UP=$((18000 + RANDOM % 500)); GW=$((18500 + RANDOM % 500))
echo "UP=$UP GW=$GW"
node "$HERE/echo-upstream.mjs" "$UP" & UPSTREAM_PID=$!
docker run -d --name "rm-gw-probe-039-portkey" --add-host=host.docker.internal:host-gateway -p "127.0.0.1:$GW:8787" portkeyai/gateway:1.15.2
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$GW/" > /dev/null && break; sleep 1; done
HOST="http://host.docker.internal:$UP/v1"
capture() { # capture <name> <extra header args...>
  local name=$1; shift
  curl -s -D "$CAP/$name.headers" -o "$CAP/$name.body" "http://127.0.0.1:$GW/v1/chat/completions" \
    -H 'content-type: application/json' "$@" \
    --data '{"model":"stub/requested","messages":[{"role":"user","content":"original user text"}]}'
}
capture plain -H 'x-portkey-provider: openai' -H "x-portkey-custom-host: $HOST" -H 'authorization: Bearer stub-key-not-secret'
capture override-params -H "x-portkey-config: {\"provider\":\"openai\",\"custom_host\":\"$HOST\",\"api_key\":\"stub-key-not-secret\",\"override_params\":{\"model\":\"stub/override\"}}"
capture input-mutator -H "x-portkey-config: {\"provider\":\"openai\",\"custom_host\":\"$HOST\",\"api_key\":\"stub-key-not-secret\",\"input_mutators\":[{\"default.addPrefix\":{\"prefix\":\"PREFIX-INJECTED: \"}}]}"
docker rm -f rm-gw-probe-039-portkey
kill "$UPSTREAM_PID"
echo "remaining:"
docker ps -a --filter name=rm-gw-probe-039 --format '{{.Names}}'
echo "--- done"
