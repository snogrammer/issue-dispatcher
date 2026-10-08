import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureToolchain,
  normalizeVersion,
  readPins,
  versionEnvName,
  type AsdfRunner,
} from "./toolchain.js";

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "toolchain-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/** A fake asdf: records calls, fails `install` for versions in `broken`. */
function fakeAsdf(broken: Set<string> = new Set()) {
  const calls: string[] = [];
  const run: AsdfRunner = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "install" && broken.has(`${args[1] ?? ""} ${args[2] ?? ""}`)) {
      return Promise.reject(
        Object.assign(new Error("exit 1"), { stderr: "BUILD FAILED\nno openssl" }),
      );
    }
    if (args[0] === "latest") return Promise.resolve(`${args[2] ?? ""}.9\n`);
    return Promise.resolve("");
  };
  return { calls, run };
}

describe("normalizeVersion", () => {
  it("keeps exact versions and turns short pins into latest:", () => {
    expect(normalizeVersion("3.12.7")).toBe("3.12.7");
    expect(normalizeVersion("3.12")).toBe("latest:3.12");
    expect(normalizeVersion("v22")).toBe("latest:22");
    expect(normalizeVersion("ruby-3.3.6")).toBe("3.3.6");
  });

  it("skips pins asdf can't install by number", () => {
    expect(normalizeVersion("system")).toBeUndefined();
    expect(normalizeVersion("lts/*")).toBeUndefined();
    expect(normalizeVersion("ref:main")).toBeUndefined();
  });
});

describe("readPins", () => {
  it("reads .tool-versions and single-tool files, .tool-versions first", () => {
    const dir = checkout({
      ".tool-versions": "# pins\npython 3.11.9 3.10.4\nnodejs system\n",
      ".python-version": "3.12\n",
      ".ruby-version": "ruby-3.3.6\n",
      ".nvmrc": "v22\n",
    });
    expect(readPins(dir)).toEqual([
      { tool: "python", version: "3.11.9", source: ".tool-versions" },
      { tool: "ruby", version: "3.3.6", source: ".ruby-version" },
      { tool: "nodejs", version: "latest:22", source: ".nvmrc" },
    ]);
  });

  it("finds nothing in a checkout without version files", () => {
    expect(readPins(checkout({ "README.md": "hi" }))).toEqual([]);
  });
});

describe("ensureToolchain", () => {
  it("does nothing without pins", async () => {
    const asdf = fakeAsdf();
    const result = await ensureToolchain(checkout({}), { timeoutMs: 1000, run: asdf.run });
    expect(result).toEqual({ env: {}, problems: [] });
    expect(asdf.calls).toEqual([]);
  });

  it("installs each pin and returns the exact versions for the run", async () => {
    const asdf = fakeAsdf();
    const dir = checkout({ ".tool-versions": "ruby 3.3.6\n", ".python-version": "3.12\n" });

    const result = await ensureToolchain(dir, { timeoutMs: 1000, run: asdf.run });

    expect(result).toEqual({
      env: { ASDF_RUBY_VERSION: "3.3.6", ASDF_PYTHON_VERSION: "3.12.9" },
      problems: [],
    });
    expect(asdf.calls).toEqual([
      "plugin add ruby",
      "install ruby 3.3.6",
      "plugin add python",
      "install python latest:3.12",
      "latest python 3.12",
    ]);
  });

  it("updates the plugin and retries once, then reports what failed", async () => {
    const asdf = fakeAsdf(new Set(["python 3.13.1"]));
    const dir = checkout({ ".tool-versions": "python 3.13.1\nruby 3.3.6\n" });

    const result = await ensureToolchain(dir, { timeoutMs: 1000, run: asdf.run });

    expect(asdf.calls.slice(0, 4)).toEqual([
      "plugin add python",
      "install python 3.13.1",
      "plugin update python",
      "install python 3.13.1",
    ]);
    expect(result.env).toEqual({ ASDF_RUBY_VERSION: "3.3.6" });
    expect(result.problems).toEqual([
      "Installing python 3.13.1 (from .tool-versions) failed: BUILD FAILED\nno openssl",
    ]);
  });

  it("reports a missing asdf instead of throwing", async () => {
    const dir = checkout({ ".python-version": "3.12.7\n" });
    const result = await ensureToolchain(dir, {
      timeoutMs: 1000,
      bin: path.join(dir, "no-such-asdf"),
    });
    expect(result.problems).toEqual([
      "asdf isn't installed here, so python 3.12.7 (from .python-version) couldn't be installed.",
    ]);
  });

  it("names version variables the way asdf reads them", () => {
    expect(versionEnvName("nodejs")).toBe("ASDF_NODEJS_VERSION");
    expect(versionEnvName("golang-ci")).toBe("ASDF_GOLANG_CI_VERSION");
  });
});
