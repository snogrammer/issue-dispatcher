import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureWritableDir } from "./fs.js";
import { StateStore } from "./state/store.js";

// Root ignores mode bits, so the read-only cases can't fail for it.
const isRoot = process.getuid?.() === 0;

describe("ensureWritableDir", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatcher-fs-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a missing directory", () => {
    const dir = path.join(tempDir(), "a", "b");
    ensureWritableDir(dir, "Workspace directory");
    expect(existsSync(dir)).toBe(true);
  });

  it.skipIf(isRoot)("names the directory and the fix when it isn't writable", () => {
    const dir = tempDir();
    chmodSync(dir, 0o500);
    expect(() => {
      ensureWritableDir(dir, "Workspace directory");
    }).toThrow(/Workspace directory .* is not writable by uid \d+ \(owner uid \d+\)\. .*chown -R/);
  });

  it.skipIf(isRoot)("stops StateStore.open before SQLite does", () => {
    const dir = tempDir();
    chmodSync(dir, 0o500);
    expect(() => StateStore.open(dir)).toThrow(/Data directory .* is not writable/);
  });
});
