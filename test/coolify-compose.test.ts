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
  [key: string]: unknown;
}
interface Compose {
  services: Record<string, Service>;
  networks?: Record<string, { name?: string; external?: boolean } | null>;
  [key: string]: unknown;
}
const compose = parseYaml(text) as Compose;
const services = Object.entries(compose.services);

describe("docker-compose.coolify.yml", () => {
  it("has no variables in volume sources", () => {
    for (const [name, service] of services) {
      for (const volume of service.volumes ?? []) {
        const source = typeof volume === "string" ? volume.split(":")[0] : JSON.stringify(volume);
        expect(source, `${name} volume ${String(volume)}`).not.toContain("${");
      }
    }
  });

  it("has no variable, named or external networks", () => {
    for (const [name, network] of Object.entries(compose.networks ?? {})) {
      expect(name).not.toContain("${");
      expect(network?.name, `network ${name}`).toBeUndefined();
      expect(network?.external, `network ${name}`).toBeUndefined();
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
});
