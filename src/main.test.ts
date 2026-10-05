import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./config/load.js";
import { silentLogger } from "./log.js";
import { createApp, main } from "./main.js";

describe("main", () => {
  it("rejects with ConfigError on invalid config before touching anything", async () => {
    await expect(main({})).rejects.toThrow(ConfigError);
  });
});

describe("createApp", () => {
  it("wires the engine without network access and stops cleanly", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatcher-app-"));
    try {
      const config = loadConfig({
        env: {
          GITEA_URL: "https://gitea.example.com",
          GITEA_TOKEN: "t",
          BOT_USERNAME: "bot",
          HUMAN_REVIEWER: "human",
          REPOS: "org/repo",
          DATA_DIR: path.join(dir, "data"),
          WORKSPACE_DIR: path.join(dir, "workspaces"),
        },
      });
      const app = createApp(config, silentLogger);
      expect(app.engine.running).toBe(0);
      await app.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
