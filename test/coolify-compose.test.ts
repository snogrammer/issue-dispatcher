import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// Coolify deploys docker-compose.coolify.yml straight from the repo, and its
// compose validator rejects things plain Docker Compose accepts. These checks
// keep the file deployable (docs/adr/0001-coolify-gitea-app-deploy.md).

const file = path.resolve(import.meta.dirname, "../docker-compose.coolify.yml");
const text = readFileSync(file, "utf8");

interface Service {
  environment?: unknown;
  volumes?: unknown[];
  healthcheck?: unknown;
  networks?: string[] | Record<string, unknown>;
  [key: string]: unknown;
}
interface Compose {
  services: Record<string, Service>;
  networks?: Record<string, { name?: string; external?: boolean } | null>;
  [key: string]: unknown;
}
const compose = parseYaml(text) as Compose;
const services = Object.entries(compose.services);

// Service networks come as a list of names or a map of name to options.
function networksOf(service: Service): string[] {
  if (Array.isArray(service.networks)) return service.networks;
  return Object.keys(service.networks ?? {});
}

describe("docker-compose.coolify.yml", () => {
  it("has no variables in volume sources", () => {
    for (const [name, service] of services) {
      for (const volume of service.volumes ?? []) {
        const source = typeof volume === "string" ? volume.split(":")[0] : JSON.stringify(volume);
        expect(source, `${name} volume ${String(volume)}`).not.toContain("${");
      }
    }
  });

  it("has no variables in network names", () => {
    for (const [name, network] of Object.entries(compose.networks ?? {})) {
      expect(name).not.toContain("${");
      expect(network?.name ?? "", `network ${name}`).not.toContain("${");
    }
  });

  // Gitea's resource network, declared by its literal name so GITEA_URL can be
  // the Gitea container's name. Only the dispatcher joins it: the test
  // services' postgres/redis aliases must stay off it (#63).
  it("puts only the dispatcher on Gitea's network", () => {
    expect(compose.networks?.gitea).toEqual({ name: "gitea_internal", external: true });
    for (const [name, service] of services) {
      const joins = networksOf(service).includes("gitea");
      expect(joins, `${name} on gitea network`).toBe(name === "dispatcher");
    }
  });

  it("writes every environment as a quoted list of KEY=value strings", () => {
    for (const [name, service] of services) {
      if (service.environment === undefined) continue;
      expect(Array.isArray(service.environment), `${name} environment`).toBe(true);
      for (const entry of service.environment as unknown[]) {
        expect(entry, `${name} environment`).toMatch(/^[A-Z][A-Z0-9_]*=/);
      }
    }
    for (const line of text.split("\n")) {
      if (/^\s+- [A-Z][A-Z0-9_]*=/.test(line)) throw new Error(`unquoted env entry: ${line}`);
    }
  });

  it("uses none of the keys Coolify manages or rejects", () => {
    for (const [name, service] of services) {
      for (const key of ["container_name", "ports", "network_mode"]) {
        expect(service[key], `${name}.${key}`).toBeUndefined();
      }
    }
    expect(Object.keys(compose).filter((key) => key.startsWith("x-"))).toEqual([]);
    for (const service of services.map(([, s]) => s)) {
      expect(Object.keys(service).filter((key) => key.startsWith("x-"))).toEqual([]);
    }
  });

  it("has no YAML anchors, aliases or merge keys", () => {
    const code = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/<<:/);
    expect(code).not.toMatch(/:\s+[&*][A-Za-z]/);
    expect(code).not.toMatch(/-\s+[&*][A-Za-z]/);
  });

  it("has no variable syntax in comments", () => {
    const comments = text.split("\n").filter((line) => line.trimStart().startsWith("#"));
    for (const line of comments) expect(line).not.toContain("${");
  });

  it("gives every service a healthcheck", () => {
    for (const [name, service] of services) {
      expect(service.healthcheck, `${name}.healthcheck`).toBeDefined();
    }
  });

  // Healthchecks run as root, where the asdf `node` shim has no version once a
  // repo has installed a Node: the container goes unhealthy and the proxy 503s (#66).
  it("runs the dispatcher healthcheck with the image's Node, not the asdf shim", () => {
    const { test } = compose.services.dispatcher?.healthcheck as { test: string[] };
    expect(test.slice(0, 2)).toEqual(["CMD", "/usr/local/bin/node"]);
  });
});

describe("Dockerfile", () => {
  it("runs the healthcheck with the image's Node, not the asdf shim", () => {
    const dockerfile = readFileSync(path.resolve(import.meta.dirname, "../Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^HEALTHCHECK [^\n]*\\\n\s+CMD \/usr\/local\/bin\/node /m);
  });
});
