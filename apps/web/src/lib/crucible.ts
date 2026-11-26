// The Crucible quickstart commands, shared by the /crucible page and its Markdown twin so the
// two never drift. They follow docs/self-hosting/quickstart.md in github.com/elm-os/crucible.

import { CRUCIBLE_REPO_URL } from "@/lib/site";

// The Crucible release the quickstart's Compose file comes from. Bump it with each Crucible release: a Compose file
// pinned to a release uses only the settings that release knows, and newer images stay compatible with it. Prose on
// the site names no version, so only this constant changes.
export const CRUCIBLE_RELEASE_TAG = "v0.1.3";

export const CRUCIBLE_DOWNLOAD_COMMAND = `mkdir crucible && cd crucible && curl -fsSLO https://raw.githubusercontent.com/elm-os/crucible/${CRUCIBLE_RELEASE_TAG}/deploy/compose/compose.yaml`;

// String.raw keeps printf's \n escape as typed. One argument per line keeps every token short, so
// the command wraps at spaces on a phone.
export const CRUCIBLE_START_COMMAND = String.raw`printf '%s\n' "CLICKHOUSE_PASSWORD=$(openssl rand -hex 16)" "POSTGRES_PASSWORD=$(openssl rand -hex 16)" "CRUCIBLE_MASTER_KEY=$(openssl rand -hex 32)" > .env && docker compose up -d --wait`;

export const CRUCIBLE_SETUP_COMMAND =
  "docker compose logs crucible | grep 'setup/?token='";

export const CRUCIBLE_SEND_COMMAND = `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <your secret key>"`;

export const CRUCIBLE_QUICKSTART_URL = `${CRUCIBLE_REPO_URL}/blob/main/docs/self-hosting/quickstart.md`;
