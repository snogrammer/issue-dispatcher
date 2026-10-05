import type { Config } from "./config/schema.js";
import { EFFORT_LEVELS } from "./config/schema.js";
import {
  ACTIVE_STATES,
  effortLabel,
  modelLabel,
  PRIORITIES,
  priorityLabel,
  questionLabel,
  stateLabel,
  type ActiveState,
  type Priority,
} from "./conventions.js";
import type { GiteaClient } from "./gitea/client.js";
import type { RepoRef } from "./gitea/types.js";

/**
 * The labels the dispatcher reads and writes, and a bootstrap that makes sure
 * each watched repo has them. Bootstrap only ever adds: a label that already
 * exists (by exact name) is left exactly as the repo owner configured it.
 */

export interface LabelSpec {
  name: string;
  /** Hex color without the leading #. */
  color: string;
  description: string;
}

const STATE_LABELS: Record<ActiveState, Omit<LabelSpec, "name">> = {
  working: { color: "fbca04", description: "Claude is implementing this issue" },
  "in-review": { color: "1d76db", description: "Claude opened PRs; waiting on CI or review" },
  blocked: { color: "b60205", description: "Claude is waiting on an answer from a human" },
};

const PRIORITY_LABELS: Record<Priority, Omit<LabelSpec, "name">> = {
  high: { color: "e99695", description: "Claude picks this up before other assigned issues" },
  low: { color: "ededed", description: "Claude picks this up after other assigned issues" },
};

/** Every label the dispatcher uses, derived from config. */
export function dispatcherLabels(config: Pick<Config, "labelPrefix" | "routing">): LabelSpec[] {
  const prefix = config.labelPrefix;
  return [
    ...ACTIVE_STATES.map((state) => ({ name: stateLabel(prefix, state), ...STATE_LABELS[state] })),
    {
      name: questionLabel(prefix),
      color: "d876e3",
      description: "Question or follow-up from Claude for a human to answer",
    },
    ...configuredModels(config.routing).map((model) => ({
      name: modelLabel(model),
      color: "c5def5",
      description: `Run Claude on this issue with the ${model} model`,
    })),
    ...EFFORT_LEVELS.map((effort) => ({
      name: effortLabel(effort),
      color: "bfdadc",
      description: `Run Claude on this issue with ${effort} effort`,
    })),
    ...PRIORITIES.map((priority) => ({
      name: priorityLabel(priority),
      ...PRIORITY_LABELS[priority],
    })),
  ];
}

/** Models from MODEL_LABELS plus any named in routing rules, deduplicated, in first-seen order. */
export function configuredModels(routing: Config["routing"]): string[] {
  const fromRules = [
    routing.default.model,
    ...Object.values(routing.phases).map((route) => route.model),
    ...Object.values(routing.repos).map((route) => route.model),
  ];
  const models = [...routing.modelLabels, ...fromRules].filter(
    (model): model is string => model !== undefined,
  );
  return [...new Set(models)];
}

export interface EnsureLabelsResult {
  created: string[];
  existing: string[];
}

export type LabelClient = Pick<GiteaClient, "listLabels" | "createLabel">;

/** Create any of `specs` missing from `repo`. Safe to run on every startup. */
export async function ensureLabels(
  client: LabelClient,
  repo: RepoRef,
  specs: LabelSpec[],
): Promise<EnsureLabelsResult> {
  const present = new Set((await client.listLabels(repo)).map((label) => label.name));
  const result: EnsureLabelsResult = { created: [], existing: [] };
  for (const spec of specs) {
    if (present.has(spec.name)) {
      result.existing.push(spec.name);
      continue;
    }
    await client.createLabel(repo, spec);
    present.add(spec.name);
    result.created.push(spec.name);
  }
  return result;
}
