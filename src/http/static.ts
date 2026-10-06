import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serves the dashboard's files: `web/` (the app) at the root and
 * `assets/brand/` under `/brand/`. Both sit at the package root, two levels
 * up from this module in `src/http/` and `dist/http/` alike. There's no build
 * step, so what's in the repo is what's served.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MOUNTS: readonly { prefix: string; dir: string }[] = [
  { prefix: "/brand/", dir: path.join(PACKAGE_ROOT, "assets", "brand") },
  { prefix: "/", dir: path.join(PACKAGE_ROOT, "web") },
];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
};

export interface StaticFile {
  type: string;
  body: Buffer;
}

/**
 * The file for a URL path, or undefined (404) for anything missing, outside
 * the mounts, or of a type not listed above.
 */
export async function staticFile(
  urlPath: string,
  mounts: readonly { prefix: string; dir: string }[] = MOUNTS,
): Promise<StaticFile | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const requested = decoded === "/" ? "/index.html" : decoded;
  const mount = mounts.find((m) => requested.startsWith(m.prefix));
  if (mount === undefined) return undefined;
  const file = path.resolve(mount.dir, `.${requested.slice(mount.prefix.length - 1)}`);
  // Refuse anything that resolves outside the mount (`..`, encoded or not).
  if (!file.startsWith(mount.dir + path.sep)) return undefined;
  const type = TYPES[path.extname(file)];
  if (type === undefined) return undefined;
  try {
    return { type, body: await readFile(file) };
  } catch {
    return undefined;
  }
}
