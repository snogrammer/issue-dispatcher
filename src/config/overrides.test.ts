import { describe, expect, it, vi } from "vitest";

import { buildConfig, ConfigError, readConfigLayers } from "./load.js";
import { applyConfig, ConfigManager, sourceOf, validateOverrides } from "./overrides.js";

const ENV = {
  GITEA_URL: "https://gitea.example.com",
  GITEA_TOKEN: "token-123456789",
  BOT_USERNAME: "bot",
  HUMAN_REVIEWER: "human",
  REPOS: "org/a",
  CONFIG_FILE: "/etc/dispatcher.yaml",
  POLL_INTERVAL_S: "90",
  CLAUDE_MODEL: "sonnet",
};

const FILE = `
pollIntervalS: 120
maxFixAttempts: 5
mergeStyle: squash
routing:
  phases:
    rebase: { model: haiku }
`;

const layers = () => readConfigLayers({ env: ENV, readFile: () => FILE });

describe("layering", () => {
  it("puts dashboard overrides above env, and env above the file", () => {
    const l = layers();
    expect(buildConfig(l, {}).pollIntervalS).toBe(90);
    expect(buildConfig(l, {}).maxFixAttempts).toBe(5);
    expect(buildConfig(l, { pollIntervalS: 30, maxFixAttempts: 1 })).toMatchObject({
      pollIntervalS: 30,
      maxFixAttempts: 1,
    });
    expect(sourceOf(l, {}, "pollIntervalS")).toBe("env");
    expect(sourceOf(l, {}, "maxFixAttempts")).toBe("file");
    expect(sourceOf(l, {}, "ciMaxQueue")).toBe("default");
    expect(sourceOf(l, { ciMaxQueue: 4 }, "ciMaxQueue")).toBe("dashboard");
  });

  it("replaces a whole value at an override's key, and null clears an optional one", () => {
    const config = buildConfig(layers(), {
      routing: { phases: { implement: { model: "opus" } } },
      mergeStyle: null,
    });
    // The file's rebase rule and env's CLAUDE_MODEL are gone: routing was replaced as a whole.
    expect(config.routing.phases).toEqual({ implement: { model: "opus" } });
    expect(config.routing.default.model).toBeUndefined();
    expect(config.mergeStyle).toBeUndefined();
  });

  it("validates overrides with the same schema and refinements", () => {
    expect(() => buildConfig(layers(), { "rateLimit.backoffMaxMin": 1 })).toThrow(
      /RATE_LIMIT_BACKOFF_MAX_MIN/,
    );
    expect(() => buildConfig(layers(), { repos: [], orgs: [] })).toThrow(/at least one repo/);
  });

  it("leaves the layers untouched", () => {
    const l = layers();
    buildConfig(l, { "routing.phases": {} });
    expect(l.file.routing).toEqual({ phases: { rebase: { model: "haiku" } } });
  });
});

describe("validateOverrides", () => {
  it("accepts editable keys only", () => {
    expect(validateOverrides({ pollIntervalS: 30, mergeStyle: null })).toEqual({
      pollIntervalS: 30,
      mergeStyle: null,
    });
    expect(() => validateOverrides({ "gitea.token": "x" })).toThrow(ConfigError);
    expect(() => validateOverrides({ "claude.permissionMode": "auto" })).toThrow(
      /can't be changed/,
    );
    expect(() => validateOverrides({ pollIntervalS: null })).toThrow(/can't be cleared/);
    expect(() => validateOverrides([1])).toThrow(/JSON object/);
  });
});

describe("applyConfig", () => {
  it("updates the live object in place and reports what changed", () => {
    const l = layers();
    const live = buildConfig(l, {});
    const rateLimit = live.rateLimit;
    const changed = applyConfig(
      live,
      buildConfig(l, { "rateLimit.backoffBaseMin": 30, mergeStyle: null, pollIntervalS: 90 }),
    );
    expect(changed).toEqual(["mergeStyle", "rateLimit.backoffBaseMin"]);
    expect(live.rateLimit).toBe(rateLimit);
    expect(rateLimit.backoffBaseMin).toBe(30);
    expect("mergeStyle" in live).toBe(false);
  });
});

describe("ConfigManager", () => {
  it("saves and applies only valid documents", () => {
    const l = layers();
    const live = buildConfig(l, {});
    const save = vi.fn();
    const onChange = vi.fn();
    const manager = new ConfigManager({ layers: l, live, overrides: {}, save, onChange });

    expect(() => manager.update({ pollIntervalS: 1 })).toThrow(ConfigError);
    expect(save).not.toHaveBeenCalled();
    expect(live.pollIntervalS).toBe(90);

    expect(manager.update({ pollIntervalS: 45 })).toEqual(["pollIntervalS"]);
    expect(save).toHaveBeenCalledWith({ pollIntervalS: 45 });
    expect(onChange).toHaveBeenCalledWith(["pollIntervalS"]);
    expect(manager.view().editable.find((e) => e.key === "pollIntervalS")).toMatchObject({
      value: 45,
      source: "dashboard",
      env: "POLL_INTERVAL_S",
    });
    expect(manager.view().configFile).toBe("/etc/dispatcher.yaml");
  });
});
