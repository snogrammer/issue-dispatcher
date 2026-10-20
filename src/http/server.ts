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
 *
 * Once it is reachable, a visitor without a session gets the landing page and
 * nothing else: `/healthz` (for the container healthcheck), the files the
 * landing page needs, and the API calls it makes to log in. Everything else
 * answers 401, or redirects to the landing page for files.
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

/** API routes the landing page uses before anyone has logged in. */
const PUBLIC_API = new Set(["/api/session", "/api/login", "/api/logout"]);

/** Static files the landing page needs; the dashboard's own shell and code stay behind login. */
const PUBLIC_FILES = new Set(["/landing.js", "/analytics.js", "/app.css"]);
const isPublicFile = (path: string) => PUBLIC_FILES.has(path) || path.startsWith("/brand/");

/** The CSP keeps the dashboard to its own files, plus `extra` origins for scripts and their requests. */
const csp = (extra = "") =>
  `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'${extra}; connect-src 'self'${extra}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

/** Applied to every response. */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": csp(),
};

/** Headers for the dashboard's files: with analytics on, the CSP also allows Plausible's origin. */
function fileHeaders(dashboard: Config["dashboard"]): Record<string, string> {
  if (dashboard.plausibleScriptUrl === undefined) return SECURITY_HEADERS;
  const origin = new URL(dashboard.plausibleScriptUrl).origin;
  return { ...SECURITY_HEADERS, "content-security-policy": csp(` ${origin}`) };
}

/** Start the server; resolves once listening. `port` overrides the configured one (tests). */
export async function startStatusServer(
  deps: ServerDeps,
  port: number = deps.config.status.port,
): Promise<StatusServer> {
  const processStartedAt = (deps.now ?? (() => new Date()))();
  const auth = new DashboardAuth(deps.config.dashboard.token);
  // Not editable from the dashboard, so fixed for the server's lifetime.
  const pageHeaders = fileHeaders(deps.config.dashboard);
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
    const authenticated = auth.isAuthenticated(request);
    const refuse = () => {
      sendJson(response, 401, { error: "log in first" });
    };
    // Only someone logged in gets the map of what's here.
    const notFound = (endpoints: string[]) => {
      sendJson(
        response,
        404,
        authenticated ? { error: "not found", endpoints } : { error: "not found" },
      );
    };

    if (path === "/healthz" || path === "/status") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      if (path === "/status" && !authenticated) {
        refuse();
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
      if (!authenticated && !PUBLIC_API.has(path)) {
        refuse();
        return;
      }
      if (path === "/api/logs/stream" && method === "GET") {
        streamLogs(request, response, deps.logs);
        return;
      }
      const reply = await handleApi(apiDeps, request, url);
      if (reply === undefined) {
        notFound(API_ENDPOINTS);
      } else {
        sendJson(response, reply.code, reply.body, reply.headers);
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (!authenticated && !isPublicFile(path) && path !== "/") {
      // Back to the landing page; the hash (the page asked for) survives the redirect.
      response.writeHead(302, { ...SECURITY_HEADERS, location: "/", "cache-control": "no-store" });
      response.end();
      return;
    }
    const served = !authenticated && path === "/" ? "/landing.html" : path;
    const file = await staticFile(served);
    if (file === undefined) {
      notFound(["/", "/healthz", "/status", ...API_ENDPOINTS]);
      return;
    }
    response.writeHead(200, {
      ...pageHeaders,
      "content-type": file.type,
      "cache-control": "no-cache",
      // "/" is the landing page or the dashboard depending on the session cookie.
      vary: "cookie",
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
