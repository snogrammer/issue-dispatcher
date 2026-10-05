import { pathToFileURL } from "node:url";

import { ConfigError, loadConfig } from "./config/load.js";

/**
 * Process entrypoint. Loads and validates config so a misconfigured deployment
 * fails at startup with a readable message; the reconcile loop (#8) plugs in here.
 */
export function main(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): void {
  const config = loadConfig({ env });
  const watching = [...config.repos, ...config.orgs.map((org) => `${org}/*`)].join(", ");
  log(`claude-dispatcher starting as ${config.gitea.botUsername}, watching ${watching}`);
}

// Run only when executed directly (`node dist/main.js`), not when imported by tests.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
