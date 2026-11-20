// The Crucible quickstart commands, shared by the /crucible page and its Markdown twin so the
// two never drift. They follow docs/self-hosting/quickstart.md in github.com/elm-os/crucible.

import { CRUCIBLE_REPO_URL } from "@/lib/site";

export const CRUCIBLE_BUILD_COMMAND = `git clone ${CRUCIBLE_REPO_URL}.git && cd crucible && docker build -f deploy/docker/Dockerfile -t crucible:dev .`;

// String.raw keeps printf's \n escapes as typed.
export const CRUCIBLE_START_COMMAND = String.raw`cd deploy/compose && printf 'CLICKHOUSE_PASSWORD=%s\nPOSTGRES_PASSWORD=%s\nCRUCIBLE_MASTER_KEY=%s\nCRUCIBLE_IMAGE=crucible:dev\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" "$(openssl rand -hex 32)" > .env && docker compose up -d --wait`;

export const CRUCIBLE_SETUP_COMMAND =
  "docker compose logs crucible | grep 'setup/?token='";

export const CRUCIBLE_SEND_COMMAND = `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <your secret key>"`;

export const CRUCIBLE_QUICKSTART_URL = `${CRUCIBLE_REPO_URL}/blob/main/docs/self-hosting/quickstart.md`;
