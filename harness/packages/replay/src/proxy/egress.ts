import { createServer, request as httpRequest } from "node:http";
import type {
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

import { hopByHopHeaders } from "./headers.js";

export interface EgressListenerOptions {
  providerBaseUrl: string;
  apiKeyEnv: string;
  hostname?: string;
  port?: number;
}

export interface EgressListener {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function responseHeaders(
  headers: IncomingHttpHeaders,
  bodyLength?: number,
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      !hopByHopHeaders.has(name) &&
      name !== "x-rightmodeler-egress-source" &&
      !(bodyLength !== undefined && name === "content-length")
    ) {
      forwarded[name] = value;
    }
  }
  if (bodyLength !== undefined) forwarded["content-length"] = bodyLength;
  return forwarded;
}

function requestHeaders(
  headers: IncomingHttpHeaders,
  credential: string,
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      !hopByHopHeaders.has(name) &&
      name !== "accept-encoding" &&
      name !== "authorization" &&
      name !== "host"
    ) {
      forwarded[name] = value;
    }
  }
  forwarded.authorization = `Bearer ${credential}`;
  return forwarded;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  source?: "egress",
): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": bytes.length,
    ...(source === undefined ? {} : { "x-rightmodeler-egress-source": source }),
  });
  response.end(bytes);
}

export function redactCredential(body: Buffer, credential: string): Buffer {
  return Buffer.from(
    body.toString("utf8").split(credential).join("[REDACTED]"),
    "utf8",
  );
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function startEgressListener(
  options: EgressListenerOptions,
): Promise<EgressListener> {
  const providerBaseUrl = new URL(options.providerBaseUrl);
  if (!/^https?:$/.test(providerBaseUrl.protocol)) {
    throw new Error("providerBaseUrl must use http or https");
  }
  if (options.apiKeyEnv.length === 0) {
    throw new Error("apiKeyEnv must not be empty");
  }

  const server = createServer((incoming, outgoing) => {
    const requestTarget = incoming.url ?? "/";
    const target = /^https?:\/\//i.test(requestTarget)
      ? new URL(requestTarget)
      : new URL(
          requestTarget.replace(/^\//, ""),
          `${providerBaseUrl.href.replace(/\/$/, "")}/`,
        );

    if (target.origin !== providerBaseUrl.origin) {
      incoming.resume();
      json(outgoing, 403, { error: "Upstream host is not allowed." }, "egress");
      return;
    }

    const credential = process.env[options.apiKeyEnv];
    if (credential === undefined || credential.length === 0) {
      incoming.resume();
      json(
        outgoing,
        500,
        {
          error: `Provider credential is unavailable: ${options.apiKeyEnv}`,
        },
        "egress",
      );
      return;
    }

    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(
      target,
      {
        method: incoming.method,
        headers: requestHeaders(incoming.headers, credential),
      },
      (upstreamResponse) => {
        const status = upstreamResponse.statusCode ?? 502;
        upstreamResponse.once("error", () => outgoing.destroy());
        if (status < 400) {
          outgoing.writeHead(status, {
            ...responseHeaders(upstreamResponse.headers),
            "x-rightmodeler-egress-source": "provider",
          });
          upstreamResponse.pipe(outgoing);
          return;
        }

        const chunks: Buffer[] = [];
        upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamResponse.once("end", () => {
          const body = redactCredential(Buffer.concat(chunks), credential);
          outgoing.writeHead(status, {
            ...responseHeaders(upstreamResponse.headers, body.length),
            "x-rightmodeler-egress-source": "provider",
          });
          outgoing.end(body);
        });
      },
    );

    upstream.once("error", () => {
      if (!outgoing.headersSent) {
        json(outgoing, 502, { error: "Provider request failed." }, "egress");
      } else {
        outgoing.destroy();
      }
    });
    incoming.once("aborted", () => upstream.destroy());
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) upstream.destroy();
    });
    incoming.pipe(upstream);
  });

  const hostname = options.hostname ?? "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    hostname,
    port: address.port,
    url: `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${address.port}`,
    close: () => close(server),
  };
}
