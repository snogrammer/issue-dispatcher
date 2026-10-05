import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CONFIG_FILE_VAR, ENV_VARS } from "./env.js";
import { ConfigError, loadConfig, redactConfig } from "./load.js";

const REQUIRED_ENV = {
  GITEA_URL: "https://gitea.example.com/",
  GITEA_TOKEN: "secret-token",
  BOT_USERNAME: "bot",
  HUMAN_REVIEWER: "reviewer",
  REPOS: "org/repo",
};

function load(env: Record<string, string>, files: Record<string, string> = {}) {
  return loadConfig({
    env,
    readFile: (file) => {
      const text = files[file];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  });
}

function loadError(env: Record<string, string>, files: Record<string, string> = {}): string {
  try {
    load(env, files);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig from env", () => {
  it("applies defaults for everything optional", () => {
    const config = load(REQUIRED_ENV);
    expect(config).toMatchObject({
      gitea: { url: "https://gitea.example.com", token: "secret-token", botUsername: "bot" },
      humanReviewer: "reviewer",
      repos: ["org/repo"],
      orgs: [],
      labelPrefix: "claude",
      pollIntervalS: 60,
      maxConcurrentSessions: 1,
      maxFixAttempts: 3,
      requireCi: true,
      ciMaxQueue: 2,
      ciNoStatusTimeoutMin: 15,
      claude: { bin: "claude", timeoutMin: 60 },
      routing: {
        default: { maxTurns: 100 },
        phases: {},
        repos: {},
        modelLabels: ["opus", "sonnet", "haiku"],
      },
      logLevel: "info",
    });
    expect(config.paths.workspaceDir).toBe(path.resolve("workspaces"));
    expect(config.paths.dataDir).toBe(path.resolve("data"));
  });

  it("parses ints, bools and lists", () => {
    const config = load({
      ...REQUIRED_ENV,
      REPOS: " a/b, ,c/d ",
      ORGS: "org1,org2",
      POLL_INTERVAL_S: "30",
      REQUIRE_CI: "no",
      CLAUDE_EFFORT: "high",
      CLAUDE_MODEL: "opus",
    });
    expect(config.repos).toEqual(["a/b", "c/d"]);
    expect(config.orgs).toEqual(["org1", "org2"]);
    expect(config.pollIntervalS).toBe(30);
    expect(config.requireCi).toBe(false);
    expect(config.routing.default).toEqual({ model: "opus", effort: "high", maxTurns: 100 });
  });

  it("treats empty variables as unset", () => {
    const config = load({ ...REQUIRED_ENV, ORGS: "", LABEL_PREFIX: "  " });
    expect(config.orgs).toEqual([]);
    expect(config.labelPrefix).toBe("claude");
  });

  it("names the env variable behind each missing value", () => {
    const message = loadError({});
    for (const name of ["GITEA_URL", "GITEA_TOKEN", "BOT_USERNAME", "HUMAN_REVIEWER"]) {
      expect(message).toContain(name);
    }
  });

  it("rejects values that don't parse", () => {
    const message = loadError({
      ...REQUIRED_ENV,
      POLL_INTERVAL_S: "soon",
      REQUIRE_CI: "maybe",
      CLAUDE_EFFORT: "extreme",
      GITEA_URL: "ftp://gitea.example.com",
    });
    expect(message).toContain("pollIntervalS (POLL_INTERVAL_S)");
    expect(message).toContain("requireCi (REQUIRE_CI)");
    expect(message).toContain("routing.default.effort (CLAUDE_EFFORT)");
    expect(message).toContain("gitea.url (GITEA_URL)");
  });

  it("enforces lower bounds", () => {
    expect(loadError({ ...REQUIRED_ENV, POLL_INTERVAL_S: "1" })).toContain("POLL_INTERVAL_S");
  });

  it("requires at least one repo or org", () => {
    const env: Record<string, string> = { ...REQUIRED_ENV };
    delete env.REPOS;
    expect(loadError(env)).toContain("at least one repo");
    expect(load({ ...env, ORGS: "org" }).orgs).toEqual(["org"]);
  });

  it("rejects malformed repo names", () => {
    expect(loadError({ ...REQUIRED_ENV, REPOS: "just-a-name" })).toContain(
      "repos.0 (REPOS): expected owner/repo",
    );
  });
});

describe("loadConfig with a YAML file", () => {
  const file = "/etc/dispatcher.yml";

  it("merges the file under env, with env winning", () => {
    const yaml = `
pollIntervalS: 120
labelPrefix: bot
claude:
  timeoutMin: 30
routing:
  default:
    model: sonnet
    maxTurns: 50
  phases:
    implement: { model: opus, effort: high }
    rebase: { model: haiku }
  repos:
    org/repo: { effort: max }
`;
    const config = load(
      { ...REQUIRED_ENV, [CONFIG_FILE_VAR]: file, POLL_INTERVAL_S: "90", CLAUDE_MODEL: "opus" },
      { [file]: yaml },
    );
    expect(config.pollIntervalS).toBe(90);
    expect(config.labelPrefix).toBe("bot");
    expect(config.claude).toEqual({ bin: "claude", timeoutMin: 30 });
    expect(config.routing).toEqual({
      default: { model: "opus", maxTurns: 50 },
      phases: { implement: { model: "opus", effort: "high" }, rebase: { model: "haiku" } },
      repos: { "org/repo": { effort: "max" } },
      modelLabels: ["opus", "sonnet", "haiku"],
    });
  });

  it("accepts an empty file", () => {
    expect(load({ ...REQUIRED_ENV, [CONFIG_FILE_VAR]: file }, { [file]: "" }).pollIntervalS).toBe(
      60,
    );
  });

  it("rejects secrets in the file", () => {
    const yaml = "gitea:\n  token: oops\n";
    expect(loadError({ ...REQUIRED_ENV, [CONFIG_FILE_VAR]: file }, { [file]: yaml })).toContain(
      "must be set with GITEA_TOKEN",
    );
  });

  it("rejects unknown keys so typos fail fast", () => {
    const message = loadError(
      { ...REQUIRED_ENV, [CONFIG_FILE_VAR]: file },
      { [file]: "pollIntervalSeconds: 30\nrouting:\n  phases:\n    deploy: {}\n" },
    );
    expect(message).toContain("pollIntervalSeconds");
    expect(message).toContain("routing.phases");
  });

  it("reports unreadable, invalid and non-mapping files", () => {
    const env = { ...REQUIRED_ENV, [CONFIG_FILE_VAR]: file };
    expect(loadError(env)).toContain(`cannot read CONFIG_FILE ${file}`);
    expect(loadError(env, { [file]: "a: [unclosed" })).toContain("invalid YAML");
    expect(loadError(env, { [file]: "- a\n- b\n" })).toContain("YAML mapping");
  });
});

describe("redactConfig", () => {
  it("hides secrets without mutating the config", () => {
    const config = load(REQUIRED_ENV);
    const redacted = redactConfig(config);
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(redacted).toMatchObject({ gitea: { token: "[redacted]" } });
    expect(config.gitea.token).toBe("secret-token");
  });
});

describe("documentation", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const names = [...ENV_VARS.map((v) => v.name), CONFIG_FILE_VAR];

  it.each(["docs/config.md", ".env.example"])("%s lists every env variable", (doc) => {
    const text = readFileSync(path.join(root, doc), "utf8");
    const missing = names.filter((name) => !new RegExp(`\\b${name}\\b`).test(text));
    expect(missing).toEqual([]);
  });
});
