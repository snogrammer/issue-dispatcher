import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// Gitea's registry (28.x) answers MANIFEST_INVALID to an image index whose
// entries are themselves indexes (#66). buildx exports an index whenever it
// adds attestations, so these checks keep the published index flat.

const file = path.resolve(import.meta.dirname, "../.gitea/workflows/publish.yml");

interface Step {
  name?: string;
  run?: string;
}
interface Job {
  steps?: Step[];
  env?: Record<string, string>;
  "timeout-minutes"?: number;
}
interface Workflow {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
}
const workflow = parseYaml(readFileSync(file, "utf8")) as Workflow;
const build = Object.values(workflow.jobs)
  .flatMap((job) => job.steps ?? [])
  .find((step) => step.name === "Build and push each platform");
const script = build?.run ?? "";

describe("publish.yml", () => {
  // Runners are shared with other projects (#66): publishes queue one at a
  // time, can't run long, and don't compile toolchains unless asked to.
  it("runs one publish at a time, whatever the event", () => {
    expect(workflow.concurrency).toEqual({ group: "publish", "cancel-in-progress": false });
  });

  it("gives up on a publish that runs long", () => {
    const timeout = workflow.jobs.publish?.["timeout-minutes"] ?? Infinity;
    expect(timeout).toBeLessThanOrEqual(15);
  });

  it("preloads no toolchains unless ASDF_PRELOAD is set", () => {
    expect(workflow.jobs.publish?.env?.ASDF_PRELOAD).toBe("${{ vars.ASDF_PRELOAD || 'none' }}");
  });

  it("has the build step", () => {
    expect(script).not.toBe("");
  });

  it("builds without attestations, so each platform pushes a plain image manifest", () => {
    const start = script.indexOf("docker buildx build");
    const command = script.slice(start, script.indexOf('-t "$ref"', start));
    expect(start).toBeGreaterThan(-1);
    expect(command).toContain("--provenance=false");
    expect(command).toContain("--sbom=false");
  });

  it("adds each platform to the index by its image manifest's digest", () => {
    expect(script).toContain('regctl image digest --platform "$platform" "$ref"');
    expect(script).toContain('pushed+=("$platform=$REGISTRY/$IMAGE@$digest")');
    expect(script).not.toContain('pushed+=("$platform=$ref")');
  });
});
