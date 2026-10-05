import { describe, expect, it } from "vitest";

import { loadConfig } from "./config/load.js";
import { routeFor } from "./routing.js";

const yaml = `
routing:
  default: { model: sonnet, effort: medium, maxTurns: 80 }
  phases:
    implement: { model: opus, effort: high }
    rebase: { model: haiku, maxTurns: 20 }
  repos:
    org/critical: { effort: max }
`;

const config = loadConfig({
  env: {
    GITEA_URL: "https://gitea.example.com",
    GITEA_TOKEN: "t",
    BOT_USERNAME: "bot",
    HUMAN_REVIEWER: "human",
    REPOS: "org/critical",
    CONFIG_FILE: "c.yml",
  },
  readFile: () => yaml,
});

describe("routeFor", () => {
  it("layers default < phase < repo", () => {
    expect(routeFor(config.routing, "fix-ci", "org/other")).toEqual({
      model: "sonnet",
      effort: "medium",
      maxTurns: 80,
    });
    expect(routeFor(config.routing, "implement", "org/other")).toEqual({
      model: "opus",
      effort: "high",
      maxTurns: 80,
    });
    expect(routeFor(config.routing, "rebase", "org/other")).toEqual({
      model: "haiku",
      effort: "medium",
      maxTurns: 20,
    });
    expect(routeFor(config.routing, "implement", "org/critical")).toEqual({
      model: "opus",
      effort: "max",
      maxTurns: 80,
    });
  });
});
