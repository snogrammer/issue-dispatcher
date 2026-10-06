import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { ConfigManager } from "../config/overrides.js";
import type { Config } from "../config/schema.js";
import type { LogBuffer, Logger } from "../log.js";
import { health, status, type StatusDeps } from "../status.js";
import { API_ENDPOINTS, handleApi, HttpError, type DashboardControl } from "./api.js";
import { DashboardAuth } from "./auth.js";
import { staticFile } from "./static.js";

/**
 * The dispatcher's one HTTP server: `/healthz` and `/status` for machines,
 * the dashboard (static files from `web/`) and its `/api` for people. It
 * binds to STATUS_HOST (127.0.0.1 by default), so nothing is reachable from
 * outside the container until an operator opts in.
 */

export interface ServerDeps extends Omit<StatusDeps, "config"> {
  config: Config;
  configManager?: ConfigManager | undefined;
  control?: DashboardControl | undefined;
  logs?: LogBuffer | undefined;
  log?: Logger | undefined;
}

export interface StatusServer {
  /** The port actually bound (tests ask for 0 to get a free one). */
  port: number;
  close(): Promise<void>;
}

const SSE_HEARTBEAT_MS = 15_000;

/** Applied to every response; the CSP keeps the dashboard to its own files. */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

/** Start the server; resolves once listening. `port` overrides the configured one (tests). */
export async function startStatusServer(
  deps: ServerDeps,
  port: number = deps.config.status.port,
): Promise<StatusServer> {
  const processStartedAt = (deps.now ?? (() => new Date()))();
  const auth = new DashboardAuth(deps.config.dashboard.token);
  const apiDeps = { ...deps, auth };

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const code = error instanceof HttpError ? error.code : 500;
      if (code === 500) deps.log?.error("status server request failed", { error });
      if (!response.headersSent) {
        sendJson(response, code, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz" || path === "/status") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      if (path === "/healthz") {
        const result = health(deps, processStartedAt);
        sendJson(response, result.ok ? 200 : 503, result);
      } else {
        sendJson(response, 200, status(deps, processStartedAt));
      }
      return;
    }

    if (path.startsWith("/api/")) {
      if (path === "/api/logs/stream" && method === "GET") {
        streamLogs(request, response, deps.logs);
        return;
      }
      const reply = await handleApi(apiDeps, request, url);
      if (reply === undefined) {
        sendJson(response, 404, { error: "not found", endpoints: API_ENDPOINTS });
      } else {
        sendJson(response, reply.code, reply.body, reply.headers);
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    const file = await staticFile(path);
    if (file === undefined) {
      sendJson(response, 404, {
        error: "not found",
        endpoints: ["/", "/healthz", "/status", ...API_ENDPOINTS],
      });
      return;
    }
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": file.type,
      "cache-control": "no-cache",
    });
    response.end(method === "HEAD" ? undefined : file.body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, deps.config.status.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        // Open log streams would otherwise hold close() forever.
        server.closeAllConnections();
      }),
  };
}

function sendJson(
  response: ServerResponse,
  code: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(code, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

/** Server-sent events: one `data:` event per new log line, plus heartbeats. */
function streamLogs(
  request: IncomingMessage,
  response: ServerResponse,
  logs: LogBuffer | undefined,
): void {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(": connected\n\n");
  const unsubscribe =
    logs?.subscribe((line) => {
      response.write(`data: ${line}\n\n`);
    }) ?? (() => undefined);
  const heartbeat = setInterval(() => {
    response.write(": ping\n\n");
  }, SSE_HEARTBEAT_MS);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
