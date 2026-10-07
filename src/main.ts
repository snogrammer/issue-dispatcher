import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runClaude, runnerOptionsFromConfig } from "./claude/runner.js";
import {
  buildConfig,
  ConfigError,
  readConfigLayers,
  redactConfig,
  type ConfigLayers,
} from "./config/load.js";
import { ConfigManager, validateOverrides, type Overrides } from "./config/overrides.js";
import type { Config } from "./config/schema.js";
import { Engine } from "./engine/engine.js";
import { prLifecycle } from "./engine/pr-lifecycle.js";
import { ensureWritableDir } from "./fs.js";
import { GiteaClient } from "./gitea/client.js";
import { GiteaError } from "./gitea/http.js";
import { startStatusServer } from "./http/server.js";
import { createLogger, LogBuffer, type Logger } from "./log.js";
import { StateStore } from "./state/store.js";
import { GitError, Workspace } from "./workspace/git.js";

/**
 * Process entrypoint: load config (failing fast with a readable message),
 * layer the dashboard's saved overrides on top, wire the real Gitea client,
 * state store, workspaces and Claude runner into the engine, serve the
 * dashboard, and stop gracefully on SIGINT/SIGTERM so in-flight work is
 * resumed on the next start.
 */

export interface App {
  engine: Engine;
  store: StateStore;
  stop(): Promise<void>;
}

export function createApp(
  config: Config,
  log: Logger,
  store: StateStore = StateStore.open(config.paths.dataDir),
): App {
  const gitea = new GiteaClient({ baseUrl: config.gitea.url, token: config.gitea.token });
  const engine = new Engine({
    config,
    gitea,
    store,
    log,
    lifecycle: prLifecycle({ config, gitea, log }),
    workspace: (repo) =>
      new Workspace(
        {
          root: config.paths.workspaceDir,
          giteaUrl: config.gitea.url,
          token: config.gitea.token,
          userName: config.git.userName,
          userEmail: config.git.userEmail,
          labelPrefix: config.labelPrefix,
        },
        repo.ref,
      ),
    // Options are read per run so dashboard changes (timeout, budget) apply to the next one.
    runClaude: (request) => runClaude(runnerOptionsFromConfig(config), request),
  });
  return {
    engine,
    store,
    async stop() {
      await engine.stop();
      store.close();
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<App> {
  const layers = readConfigLayers({ env });
  const base = buildConfig(layers, {});
  const logs = new LogBuffer();
  const log = createLogger(base.logLevel, {
    secrets: [
      base.gitea.token,
      base.dashboard.token,
      env.CLAUDE_CODE_OAUTH_TOKEN,
      env.ANTHROPIC_API_KEY,
    ],
    sink: (line) => {
      logs.push(line);
    },
  });

  // Paths aren't editable from the dashboard, so the base config finds the store.
  // Check the workspace mount now rather than on the first clone.
  ensureWritableDir(base.paths.workspaceDir, "Workspace directory");
  const store = StateStore.open(base.paths.dataDir);
  const { config, overrides } = withSavedOverrides(layers, base, store.getConfigOverrides(), log);
  log.setLevel(config.logLevel);
  log.info("IssueDispatcher starting", {
    config: redactConfig(config),
    dashboardOverrides: Object.keys(overrides),
  });

  const app = createApp(config, log, store);
  const configManager = new ConfigManager({
    layers,
    live: config,
    overrides,
    save: (next) => {
      store.setConfigOverrides(next);
    },
    onChange: (changed) => {
      if (changed.includes("logLevel")) log.setLevel(config.logLevel);
      app.engine.configChanged(changed);
    },
  });
  // Up before the first poll, so a container healthcheck sees startup progress.
  const server =
    config.status.port === 0
      ? undefined
      : await startStatusServer({
          config,
          store: app.store,
          snapshot: () => app.engine.snapshot(),
          version: packageVersion(),
          configManager,
          control: app.engine,
          logs,
          log,
        });
  if (server) {
    log.info("status server and dashboard listening", {
      host: config.status.host,
      port: server.port,
      dashboardWrites: config.dashboard.token !== undefined,
    });
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down; in-flight work resumes on next start", { signal });
    Promise.all([app.stop(), server?.close()]).then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("shutdown failed", { error });
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await app.engine.start();
  } catch (error) {
    // Don't let the open status server keep a failed process alive.
    await Promise.all([app.stop(), server?.close()]);
    throw error;
  }
  log.info("watching repos", { repos: app.engine.watchedRepos().map((repo) => repo.fullName) });
  return app;
}

/**
 * Apply the overrides saved from the dashboard. If they no longer validate
 * (env changed underneath them, or a newer build tightened a limit), start
 * without them rather than refusing to start: the dashboard can fix them.
 */
function withSavedOverrides(
  layers: ConfigLayers,
  base: Config,
  saved: Overrides,
  log: Logger,
): { config: Config; overrides: Overrides } {
  if (Object.keys(saved).length === 0) return { config: base, overrides: {} };
  try {
    const overrides = validateOverrides(saved);
    return { config: buildConfig(layers, overrides), overrides };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log.warn("ignoring saved dashboard config; it is no longer valid", { error });
    return { config: base, overrides: {} };
  }
}

/** The version from package.json (next to dist/ at runtime), or "unknown". */
function packageVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Run only when executed directly (`node dist/main.js`), not when imported by tests.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    // Expected startup problems (bad config, wrong bot user, unreachable Gitea)
    // get a one-line message; anything else keeps its stack trace.
    const portInUse = (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
    const expected =
      error instanceof ConfigError ||
      error instanceof GiteaError ||
      error instanceof GitError ||
      portInUse;
    console.error(
      expected
        ? `startup failed: ${portInUse ? "STATUS_PORT is already in use. " : ""}${(error as Error).message}`
        : error,
    );
    process.exitCode = 1;
  });
}
