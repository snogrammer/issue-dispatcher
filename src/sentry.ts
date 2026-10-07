import os from "node:os";

import type { Config } from "./config/schema.js";
import { makeRedactor, type Fields, type Level } from "./log.js";

/**
 * Optional error reporting to Sentry, switched on by SENTRY_DSN. Several
 * services share the Sentry org, so every event carries who sent it: the
 * service name (tag and release prefix), environment, instance (server name),
 * the build's version and commit, and which bot and Gitea it works for.
 *
 * Reporting rides on the logger: error and fatal lines become events, warn
 * lines become breadcrumbs that give the next event context. Uncaught
 * exceptions and unhandled rejections are captured by the SDK itself. Secret
 * values are scrubbed from every event and breadcrumb before it leaves, the
 * same way the logger scrubs its lines.
 */

/** The slice of `@sentry/node` used here, so tests can pass a fake. */
export interface SentryApi {
  init: (typeof import("@sentry/node"))["init"];
  withScope: (typeof import("@sentry/node"))["withScope"];
  captureException: (typeof import("@sentry/node"))["captureException"];
  captureMessage: (typeof import("@sentry/node"))["captureMessage"];
  addBreadcrumb: (typeof import("@sentry/node"))["addBreadcrumb"];
  flush: (typeof import("@sentry/node"))["flush"];
}

export interface ErrorReporter {
  /** Pass as the logger's `report` option. */
  report: (level: Level, message: string, fields: Fields) => void;
  captureException: (error: unknown) => void;
  /** Wait (up to `timeoutMs`) for queued events to be sent; call before exiting. */
  flush: (timeoutMs: number) => Promise<boolean>;
}

export interface SentryIdentity {
  version: string;
  commit: string;
  /** Values scrubbed from events, as for the logger. */
  secrets: readonly (string | undefined)[];
  env?: NodeJS.ProcessEnv;
}

/** Logger fields promoted to searchable tags; the rest go in the event's "log" context. */
const TAG_FIELDS = ["repo", "issue", "pr", "phase"] as const;

const SEVERITY = {
  trace: "debug",
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
  fatal: "fatal",
} as const;

/**
 * Start the Sentry SDK if `config.sentry.dsn` is set; otherwise return
 * undefined without loading it.
 */
export async function initSentry(
  config: Config,
  identity: SentryIdentity,
  load: () => Promise<SentryApi> = () => import("@sentry/node"),
): Promise<ErrorReporter | undefined> {
  const { dsn, serviceName } = config.sentry;
  if (dsn === undefined) return undefined;
  const sentry = await load();
  const env = identity.env ?? process.env;
  const redact = makeRedactor([...identity.secrets, dsn]);
  const scrub = <T>(value: T): T => JSON.parse(redact(JSON.stringify(value))) as T;
  const commit = identity.commit === "unknown" ? undefined : identity.commit;

  sentry.init({
    dsn,
    environment: config.sentry.environment ?? env.NODE_ENV ?? "production",
    release: `${serviceName}@${identity.version}`,
    dist: commit,
    serverName: config.sentry.instance ?? os.hostname(),
    // Errors carry what we put in them; don't let instrumentation add request
    // headers (the Gitea token, the dashboard bearer), bodies or user data.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    initialScope: {
      tags: {
        service: serviceName,
        commit: identity.commit,
        bot: config.gitea.botUsername,
        gitea_host: new URL(config.gitea.url).hostname,
      },
    },
    beforeSend: (event) => scrub(event),
    beforeBreadcrumb: (breadcrumb) => scrub(breadcrumb),
  });

  return {
    report: (level, message, fields) => {
      // Reporting must never break the log line that triggered it.
      try {
        if (level === "warn") {
          sentry.addBreadcrumb({
            category: "log",
            level: "warning",
            message,
            data: plain(fields),
          });
          return;
        }
        sentry.withScope((scope) => {
          scope.setLevel(SEVERITY[level]);
          const { error, ...rest } = fields;
          for (const key of TAG_FIELDS) {
            const value = rest[key];
            if (typeof value === "string" || typeof value === "number") {
              scope.setTag(key, String(value));
            }
          }
          scope.setContext("log", { msg: message, ...plain(rest) });
          if (error instanceof Error) {
            sentry.captureException(error);
          } else {
            if (error !== undefined) scope.setExtra("error", plain({ error }).error);
            sentry.captureMessage(message);
          }
        });
      } catch {
        // Ignore: stdout still has the line.
      }
    },
    captureException: (error) => {
      sentry.captureException(error);
    },
    flush: (timeoutMs) => sentry.flush(timeoutMs),
  };
}

/** Fields as JSON-safe data, with errors reduced to name and message (as in log lines). */
function plain(fields: Fields): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(fields, (_key, value: unknown) =>
      value instanceof Error ? { name: value.name, message: value.message } : value,
    ),
  ) as Record<string, unknown>;
}
