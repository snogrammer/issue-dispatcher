import { describe, expect, it } from "vitest";

import { loadConfig } from "./config/load.js";
import type { Phase } from "./config/schema.js";
import { resolveRoute, type ResolvedRoute } from "./routing.js";

const yaml = `
routing:
  default: { model: sonnet, effort: medium, maxTurns: 80 }
  phases:
    implement: { model: opus, effort: high }
    rebase: { model: haiku, maxTurns: 20 }
  repos:
    org/critical: { effort: max }
  modelLabels: [opus, sonnet, haiku, fable]
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

type Case = [string, Phase, string, string[], ResolvedRoute];

// [description, phase, repo, labels, expected route]
const CASES: Case[] = [
  [
    "global default",
    "fix-ci",
    "org/other",
    [],
    { model: "sonnet", effort: "medium", maxTurns: 80 },
  ],
  [
    "phase over default",
    "implement",
    "org/other",
    [],
    { model: "opus", effort: "high", maxTurns: 80 },
  ],
  [
    "phase sets turns",
    "rebase",
    "org/other",
    [],
    { model: "haiku", effort: "medium", maxTurns: 20 },
  ],
  [
    "repo over phase",
    "implement",
    "org/critical",
    [],
    { model: "opus", effort: "max", maxTurns: 80 },
  ],
  [
    "labels over everything",
    "implement",
    "org/critical",
    ["bug", "model:fable", "effort:low"],
    { model: "fable", effort: "low", maxTurns: 80 },
  ],
  [
    "one label kind leaves the other layered",
    "rebase",
    "org/other",
    ["effort:xhigh"],
    { model: "haiku", effort: "xhigh", maxTurns: 20 },
  ],
];

describe("resolveRoute", () => {
  it.each(CASES)("%s", (_name, phase, repo, labels, expected) => {
    expect(resolveRoute(config.routing, phase, repo, labels)).toEqual({
      route: expected,
      ignored: [],
    });
  });

  it("ignores models that aren't configured", () => {
    expect(resolveRoute(config.routing, "implement", "org/other", ["model:gpt-9"])).toEqual({
      route: { model: "opus", effort: "high", maxTurns: 80 },
      ignored: ["model:gpt-9 (not a configured model; add it to MODEL_LABELS)"],
    });
  });

  it("ignores unknown effort levels", () => {
    const { route, ignored } = resolveRoute(config.routing, "fix-ci", "org/other", [
      "effort:extreme",
    ]);
    expect(route.effort).toBe("medium");
    expect(ignored).toEqual(["effort:extreme (not one of low, medium, high, xhigh, max)"]);
  });

  it("ignores conflicting labels of the same kind", () => {
    const { route, ignored } = resolveRoute(config.routing, "fix-ci", "org/other", [
      "model:opus",
      "model:haiku",
      "effort:high",
    ]);
    expect(route).toEqual({ model: "sonnet", effort: "high", maxTurns: 80 });
    expect(ignored).toEqual(["model:opus, model:haiku (conflicting model labels)"]);
  });

  it("accepts models named only in routing rules", () => {
    const { route } = resolveRoute(config.routing, "fix-ci", "org/other", ["model:sonnet"]);
    expect(route.model).toBe("sonnet");
  });
});
