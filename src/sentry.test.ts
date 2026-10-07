import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "./config/load.js";
import { initSentry, type SentryApi } from "./sentry.js";

const DSN = "https://publickey@o1.ingest.sentry.io/42";

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    env: {
      GITEA_URL: "https://gitea.example.com",
      GITEA_TOKEN: "gitea-token-123456",
      BOT_USERNAME: "bot",
      HUMAN_REVIEWER: "reviewer",
      REPOS: "org/repo",
      ...extra,
    },
  });
}

/** A stand-in for @sentry/node that records what it was asked to do. */
function fakeSentry() {
  const scope = {
    setLevel: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
    setExtra: vi.fn(),
  };
  const api = {
    init: vi.fn(),
    withScope: vi.fn((callback: (s: typeof scope) => void) => {
      callback(scope);
    }),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    flush: vi.fn(() => Promise.resolve(true)),
  };
  return { api, scope, load: () => Promise.resolve(api as unknown as SentryApi) };
}

const identity = { version: "0.1.0", commit: "abc123", secrets: ["gitea-token-123456"], env: {} };

describe("initSentry", () => {
  it("does nothing without a DSN", async () => {
    const load = vi.fn();
    await expect(initSentry(config(), identity, load)).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it("identifies the service, build and instance on every event", async () => {
    const { api, load } = fakeSentry();
    await initSentry(
      config({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "staging", SENTRY_INSTANCE: "nas-1" }),
      identity,
      load,
    );
    expect(api.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: DSN,
        environment: "staging",
        release: "claude-dispatcher@0.1.0",
        dist: "abc123",
        serverName: "nas-1",
        initialScope: {
          tags: {
            service: "claude-dispatcher",
            commit: "abc123",
            bot: "bot",
            gitea_host: "gitea.example.com",
          },
        },
      }),
    );
  });

  it("falls back to NODE_ENV, the hostname and no dist", async () => {
    const { api, load } = fakeSentry();
    await initSentry(
      config({ SENTRY_DSN: DSN, SENTRY_SERVICE_NAME: "issue-dispatcher" }),
      { ...identity, commit: "unknown", env: { NODE_ENV: "development" } },
      load,
    );
    const options = api.init.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({
      environment: "development",
      release: "issue-dispatcher@0.1.0",
      dist: undefined,
    });
    expect(typeof options.serverName).toBe("string");
  });

  it("scrubs secrets and the DSN from outgoing events and breadcrumbs", async () => {
    const { api, load } = fakeSentry();
    await initSentry(config({ SENTRY_DSN: DSN }), identity, load);
    const options = api.init.mock.calls[0]?.[0] as {
      beforeSend: (event: unknown) => unknown;
      beforeBreadcrumb: (breadcrumb: unknown) => unknown;
    };
    const event = options.beforeSend({
      exception: { values: [{ value: "401 for gitea-token-123456 via " + DSN }] },
    });
    expect(JSON.stringify(event)).not.toContain("gitea-token-123456");
    expect(JSON.stringify(event)).not.toContain(DSN);
    expect(JSON.stringify(options.beforeBreadcrumb({ message: "gitea-token-123456" }))).toContain(
      "[redacted]",
    );
  });
});

describe("ErrorReporter.report", () => {
  async function setup() {
    const fake = fakeSentry();
    const reporter = await initSentry(config({ SENTRY_DSN: DSN }), identity, fake.load);
    if (!reporter) throw new Error("expected a reporter");
    return { ...fake, reporter };
  }

  it("captures errors as exceptions, with log fields as tags and context", async () => {
    const { api, scope, reporter } = await setup();
    const error = new Error("boom");
    reporter.report("error", "run handling failed", { repo: "org/repo", issue: 7, error });
    expect(api.captureException).toHaveBeenCalledWith(error);
    expect(scope.setLevel).toHaveBeenCalledWith("error");
    expect(scope.setTag).toHaveBeenCalledWith("repo", "org/repo");
    expect(scope.setTag).toHaveBeenCalledWith("issue", "7");
    expect(scope.setContext).toHaveBeenCalledWith("log", {
      msg: "run handling failed",
      repo: "org/repo",
      issue: 7,
    });
  });

  it("captures error lines without an Error as messages", async () => {
    const { api, scope, reporter } = await setup();
    reporter.report("fatal", "gave up", { error: "string reason" });
    expect(api.captureMessage).toHaveBeenCalledWith("gave up");
    expect(scope.setLevel).toHaveBeenCalledWith("fatal");
    expect(scope.setExtra).toHaveBeenCalledWith("error", "string reason");
  });

  it("records warnings as breadcrumbs, not events", async () => {
    const { api, reporter } = await setup();
    reporter.report("warn", "rate limited", { repo: "org/repo" });
    expect(api.addBreadcrumb).toHaveBeenCalledWith({
      category: "log",
      level: "warning",
      message: "rate limited",
      data: { repo: "org/repo" },
    });
    expect(api.captureMessage).not.toHaveBeenCalled();
  });

  it("never throws into the logger", async () => {
    const { api, reporter } = await setup();
    api.withScope.mockImplementation(() => {
      throw new Error("sdk broke");
    });
    expect(() => {
      reporter.report("error", "x", {});
    }).not.toThrow();
  });
});
