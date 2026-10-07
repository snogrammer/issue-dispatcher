import { accessSync, constants, mkdirSync, statSync } from "node:fs";

/**
 * Creates `dir` if needed and fails fast when this process can't write to it.
 *
 * A bind mount whose host directory Docker created on first deploy is owned by
 * root, so `mkdir -p` succeeds (the directory exists) and the failure would
 * otherwise surface later as an opaque error, e.g. SQLite's "unable to open
 * database file". This turns it into a message that says what to fix.
 */
export function ensureWritableDir(dir: string, label: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    accessSync(dir, constants.W_OK);
  } catch (error) {
    const uid = process.getuid?.();
    let owner = "unknown";
    try {
      owner = String(statSync(dir).uid);
    } catch {
      // Keep "unknown"; the access error is the one worth reporting.
    }
    const who = uid === undefined ? "this process" : `uid ${String(uid)}`;
    const fix =
      uid === undefined
        ? ""
        : ` Fix ownership, e.g. on the host: chown -R ${String(uid)}:${String(uid)} <host path>.`;
    throw new Error(`${label} ${dir} is not writable by ${who} (owner uid ${owner}).${fix}`, {
      cause: error,
    });
  }
}
