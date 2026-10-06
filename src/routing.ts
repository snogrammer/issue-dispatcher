import { EFFORT_LEVELS, type Config, type Phase, type RouteSpec } from "./config/schema.js";
import { configuredModels } from "./labels.js";

/**
 * Which model, effort and turn limit a run uses. Each layer overrides the
 * ones before it:
 *
 *   global default  <  phase rule  <  repo rule  <  issue labels
 *
 * Labels are the per-issue escape hatch: `model:<name>` and `effort:<level>`.
 * A model label must name a configured model (MODEL_LABELS or a model in the
 * routing rules) and an effort label a level the CLI accepts; anything else,
 * or two conflicting labels of the same kind, is ignored with a warning so a
 * typo never reaches the CLI as a bad flag.
 */
export type ResolvedRoute = RouteSpec & { maxTurns: number };

export interface RouteResolution {
  route: ResolvedRoute;
  /** Labels that were ignored, with the reason. */
  ignored: string[];
}

export function resolveRoute(
  routing: Config["routing"],
  phase: Phase,
  repo: string,
  labelNames: readonly string[] = [],
): RouteResolution {
  const { label, ignored } = fromLabels(routing, labelNames);
  const layers: RouteSpec[] = [
    routing.default,
    routing.phases[phase] ?? {},
    routing.repos[repo] ?? {},
    label,
  ];
  const route: ResolvedRoute = { maxTurns: routing.default.maxTurns };
  for (const layer of layers) {
    if (layer.model !== undefined) route.model = layer.model;
    if (layer.effort !== undefined) route.effort = layer.effort;
    if (layer.maxTurns !== undefined) route.maxTurns = layer.maxTurns;
  }
  return { route, ignored };
}

/** The route without label warnings (labels default to none). */
export function routeFor(
  routing: Config["routing"],
  phase: Phase,
  repo: string,
  labelNames: readonly string[] = [],
): ResolvedRoute {
  return resolveRoute(routing, phase, repo, labelNames).route;
}

function fromLabels(
  routing: Config["routing"],
  labelNames: readonly string[],
): { label: RouteSpec; ignored: string[] } {
  const ignored: string[] = [];
  const known = new Set(configuredModels(routing));
  const models = values(labelNames, "model:");
  const efforts = values(labelNames, "effort:");
  const label: RouteSpec = {};

  const model = single("model", models, ignored);
  if (model !== undefined) {
    if (known.has(model)) label.model = model;
    else ignored.push(`model:${model} (not a configured model; add it to MODEL_LABELS)`);
  }
  const effort = single("effort", efforts, ignored);
  if (effort !== undefined) {
    const level = EFFORT_LEVELS.find((candidate) => candidate === effort);
    if (level) label.effort = level;
    else ignored.push(`effort:${effort} (not one of ${EFFORT_LEVELS.join(", ")})`);
  }
  return { label, ignored };
}

function values(labelNames: readonly string[], prefix: string): string[] {
  return [
    ...new Set(
      labelNames.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length)),
    ),
  ];
}

/** The one value of a label kind, or undefined (recording why) when there are several. */
function single(kind: string, found: string[], ignored: string[]): string | undefined {
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    ignored.push(
      `${found.map((value) => `${kind}:${value}`).join(", ")} (conflicting ${kind} labels)`,
    );
  }
  return undefined;
}
