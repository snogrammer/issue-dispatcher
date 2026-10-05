import { pathToFileURL } from "node:url";

/**
 * Process entrypoint. Config loading (#3) and the reconcile loop (#8) plug in
 * here; for now it only proves the build, test and container wiring work.
 */
export function main(log: (message: string) => void = console.log): void {
  log("claude-dispatcher starting (scaffold: no work loop yet)");
}

// Run only when executed directly (`node dist/main.js`), not when imported by tests.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
