import { pathToFileURL } from "node:url";

import { runClaude, runnerOptionsFromConfig } from "./claude/runner.js";
import { ConfigError, loadConfig, redactConfig } from "./config/load.js";
import type { Config } from "./config/schema.js";
import { Engine } from "./engine/engine.js";
import { prLifecycle } from "./engine/pr-lifecycle.js";
import { GiteaClient } from "./gitea/client.js";
import { GiteaError } from "./gitea/http.js";
import { createLogger, type Logger } from "./log.js";
import { StateStore } from "./state/store.js";
import { GitError, Workspace } from "./workspace/git.js";

/**
 * Process entrypoint: load config (failing fast with a readable message),
 * wire the real Gitea client, state store, workspaces and Claude runner into
 * the engine, and stop gracefully on SIGINT/SIGTERM so in-flight work is
 * resumed on the next start.
 */

export interface App {
  engine: Engine;
  stop(): Promise<void>;
}

export function createApp(config: Config, log: Logger): App {
  const gitea = new GiteaClient({ baseUrl: config.gitea.url, token: config.gitea.token });
  const store = StateStore.open(config.paths.dataDir);
  const runner = runnerOptionsFromConfig(config);
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
    runClaude: (request) => runClaude(runner, request),
  });
  return {
    engine,
    async stop() {
      await engine.stop();
      store.close();
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<App> {
  const config = loadConfig({ env });
  const log = createLogger(config.logLevel);
  log.info("claude-dispatcher starting", { config: redactConfig(config) });

  const app = createApp(config, log);
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down; in-flight work resumes on next start", { signal });
    app.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("shutdown failed", { error });
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await app.engine.start();
  log.info("watching repos", { repos: app.engine.watchedRepos().map((repo) => repo.fullName) });
  return app;
}

// Run only when executed directly (`node dist/main.js`), not when imported by tests.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    // Expected startup problems (bad config, wrong bot user, unreachable Gitea)
    // get a one-line message; anything else keeps its stack trace.
    const expected =
      error instanceof ConfigError || error instanceof GiteaError || error instanceof GitError;
    console.error(expected ? `startup failed: ${error.message}` : error);
    process.exitCode = 1;
  });
}
