import { describe, expect, it } from "vitest";

import { loadConfig } from "./config/load.js";
import type { Label } from "./gitea/types.js";
import {
  configuredModels,
  dispatcherLabels,
  ensureLabels,
  type LabelClient,
  type LabelSpec,
} from "./labels.js";

const BASE_ENV = {
  GITEA_URL: "https://gitea.example.com",
  GITEA_TOKEN: "t",
  BOT_USERNAME: "bot",
  HUMAN_REVIEWER: "me",
  REPOS: "org/repo",
};

function config(env: Record<string, string> = {}, yaml?: string) {
  return loadConfig({
    env: { ...BASE_ENV, ...env, ...(yaml === undefined ? {} : { CONFIG_FILE: "c.yml" }) },
    readFile: () => yaml ?? "",
  });
}

describe("dispatcherLabels", () => {
  it("lists state, question, routing and priority labels for the default config", () => {
    expect(dispatcherLabels(config()).map((label) => label.name)).toEqual([
      "claude:working",
      "claude:in-review",
      "claude:blocked",
      "claude:question",
      "model:opus",
      "model:sonnet",
      "model:haiku",
      "effort:low",
      "effort:medium",
      "effort:high",
      "effort:xhigh",
      "effort:max",
      "priority:high",
      "priority:low",
    ]);
  });

  it("uses the configured prefix and models", () => {
    const names = dispatcherLabels(config({ LABEL_PREFIX: "bot", MODEL_LABELS: "fable" })).map(
      (label) => label.name,
    );
    expect(names.slice(0, 4)).toEqual([
      "bot:working",
      "bot:in-review",
      "bot:blocked",
      "bot:question",
    ]);
    expect(names.filter((name) => name.startsWith("model:"))).toEqual(["model:fable"]);
  });

  it("gives every label a unique name, a hex color and a description", () => {
    const labels = dispatcherLabels(config());
    expect(new Set(labels.map((label) => label.name)).size).toBe(labels.length);
    for (const label of labels) {
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      expect(label.description).not.toBe("");
    }
  });
});

describe("configuredModels", () => {
  it("adds models named in routing rules, without duplicates", () => {
    const yaml = `
routing:
  default: { model: claude-opus-5-5 }
  phases:
    implement: { model: opus }
    rebase: { model: haiku, effort: low }
    fix-ci: { effort: high }
  repos:
    org/repo: { model: fable }
`;
    expect(configuredModels(config({}, yaml).routing)).toEqual([
      "opus",
      "sonnet",
      "haiku",
      "claude-opus-5-5",
      "fable",
    ]);
  });

  it("can be limited to routing-rule models with an empty MODEL_LABELS list in YAML", () => {
    const yaml = "routing:\n  modelLabels: []\n  default: { model: sonnet }\n";
    expect(configuredModels(config({}, yaml).routing)).toEqual(["sonnet"]);
  });
});

describe("ensureLabels", () => {
  const repo = { owner: "org", name: "repo" };

  function fakeRepoLabels(initial: Pick<Label, "name" | "color">[]) {
    const labels = initial.map((label, id) => ({
      id,
      description: "",
      exclusive: false,
      ...label,
    }));
    const created: LabelSpec[] = [];
    const client: LabelClient = {
      listLabels: () => Promise.resolve([...labels]),
      createLabel: (_repo, input) => {
        const label = { id: labels.length, exclusive: false, description: "", ...input };
        labels.push(label);
        created.push({
          name: input.name,
          color: input.color,
          description: input.description ?? "",
        });
        return Promise.resolve(label);
      },
    };
    return { client, labels, created };
  }

  const specs: LabelSpec[] = [
    { name: "claude:working", color: "fbca04", description: "working" },
    { name: "claude:blocked", color: "b60205", description: "blocked" },
  ];

  it("creates only the missing labels and leaves existing ones untouched", async () => {
    const { client, labels, created } = fakeRepoLabels([
      { name: "claude:working", color: "#000000" },
      { name: "bug", color: "#ff0000" },
    ]);

    expect(await ensureLabels(client, repo, specs)).toEqual({
      created: ["claude:blocked"],
      existing: ["claude:working"],
    });
    expect(created).toEqual([specs[1]]);
    expect(labels.find((label) => label.name === "claude:working")?.color).toBe("#000000");
  });

  it("is idempotent", async () => {
    const { client, created } = fakeRepoLabels([]);
    await ensureLabels(client, repo, specs);
    const second = await ensureLabels(client, repo, specs);
    expect(second).toEqual({ created: [], existing: ["claude:working", "claude:blocked"] });
    expect(created).toHaveLength(2);
  });

  it("matches names exactly", async () => {
    const { client } = fakeRepoLabels([{ name: "Claude:Working", color: "#000000" }]);
    expect((await ensureLabels(client, repo, specs)).created).toEqual([
      "claude:working",
      "claude:blocked",
    ]);
  });
});
