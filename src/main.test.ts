import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "./config/load.js";
import { main } from "./main.js";

const ENV = {
  GITEA_URL: "https://gitea.example.com",
  GITEA_TOKEN: "token",
  BOT_USERNAME: "bot",
  HUMAN_REVIEWER: "reviewer",
  REPOS: "org/repo",
  ORGS: "other",
};

describe("main", () => {
  it("logs who it runs as and what it watches", () => {
    const log = vi.fn();
    main(ENV, log);
    expect(log).toHaveBeenCalledWith(
      "claude-dispatcher starting as bot, watching org/repo, other/*",
    );
  });

  it("throws ConfigError on invalid config", () => {
    expect(() => {
      main({}, vi.fn());
    }).toThrow(ConfigError);
  });
});
