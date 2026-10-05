import type { Config, Phase, RouteSpec } from "./config/schema.js";

/**
 * Which model, effort and turn limit a run uses. Later layers override
 * earlier ones: global default, then the phase rule, then the repo rule.
 * Issue labels (`model:*`, `effort:*`) are layered on top by the routing
 * feature.
 */
export type ResolvedRoute = RouteSpec & { maxTurns: number };

export function routeFor(routing: Config["routing"], phase: Phase, repo: string): ResolvedRoute {
  const layers: RouteSpec[] = [
    routing.default,
    routing.phases[phase] ?? {},
    routing.repos[repo] ?? {},
  ];
  const route: ResolvedRoute = { maxTurns: routing.default.maxTurns };
  for (const layer of layers) {
    if (layer.model !== undefined) route.model = layer.model;
    if (layer.effort !== undefined) route.effort = layer.effort;
    if (layer.maxTurns !== undefined) route.maxTurns = layer.maxTurns;
  }
  return route;
}
