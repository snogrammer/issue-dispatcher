import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Who may change things from the dashboard. Reading stays open, like
 * /status. Config edits and control actions need DASHBOARD_TOKEN, sent as
 * `Authorization: Bearer <token>` (scripts) or exchanged at /api/login for
 * a session cookie (the browser). Without a token configured, writes are off
 * entirely rather than open.
 *
 * The cookie holds an HMAC of the token, not the token itself, so it changes
 * whenever the token is rotated and every session ends with it. Cookie-
 * authenticated writes must also come from the dashboard's own origin; the
 * SameSite=Strict cookie already blocks most cross-site requests, and the
 * Origin check covers the rest. Bearer requests can't be forged by another
 * site, so they skip it.
 */

export const SESSION_COOKIE = "idsession";

/** Failed logins allowed per window before /api/login answers 429. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;

export type AuthResult = { ok: true } | { ok: false; code: 401 | 403; error: string };

export class DashboardAuth {
  private readonly session: Buffer | undefined;
  private failures: number[] = [];

  constructor(
    private readonly token: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.session =
      token === undefined
        ? undefined
        : createHmac("sha256", token).update("dashboard-session").digest();
  }

  get writesEnabled(): boolean {
    return this.token !== undefined;
  }

  isAuthenticated(request: IncomingMessage): boolean {
    return this.bearer(request) || this.cookie(request);
  }

  /** May this request change something? */
  authorizeWrite(request: IncomingMessage): AuthResult {
    if (!this.writesEnabled) {
      return {
        ok: false,
        code: 403,
        error: "writes are disabled: set DASHBOARD_TOKEN to enable them",
      };
    }
    if (this.bearer(request)) return { ok: true };
    if (!this.cookie(request)) return { ok: false, code: 401, error: "log in first" };
    if (!sameOrigin(request))
      return { ok: false, code: 403, error: "cross-origin request refused" };
    return { ok: true };
  }

  /** Check a login attempt. `undefined` means too many recent failures. */
  login(candidate: unknown): boolean | undefined {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    if (this.failures.length >= MAX_FAILURES) return undefined;
    const ok = typeof candidate === "string" && this.matchesToken(candidate);
    if (!ok) this.failures.push(now);
    return ok;
  }

  /** Set-Cookie value for a new session. */
  sessionCookie(request: IncomingMessage): string {
    if (this.session === undefined) throw new Error("no dashboard token configured");
    return cookie(request, this.session.toString("base64url"), "Max-Age=2592000");
  }

  clearCookie(request: IncomingMessage): string {
    return cookie(request, "", "Max-Age=0");
  }

  private matchesToken(candidate: string): boolean {
    if (this.token === undefined) return false;
    return safeEqual(Buffer.from(candidate), Buffer.from(this.token));
  }

  private bearer(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    const match = header === undefined ? null : /^Bearer\s+(.+)$/i.exec(header);
    return match?.[1] !== undefined && this.matchesToken(match[1].trim());
  }

  private cookie(request: IncomingMessage): boolean {
    if (this.session === undefined) return false;
    const value = readCookie(request, SESSION_COOKIE);
    return value !== undefined && safeEqual(Buffer.from(value, "base64url"), this.session);
  }
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookie(request: IncomingMessage, value: string, lifetime: string): string {
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; ${lifetime}${secure}`;
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/**
 * The request's Origin names the host it was sent to. Browsers send Origin
 * on every POST/PUT/DELETE, so a missing one isn't from the dashboard page.
 */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host === (Array.isArray(host) ? host[0] : host);
  } catch {
    return false;
  }
}
