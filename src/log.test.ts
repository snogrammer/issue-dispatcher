import { describe, expect, it } from "vitest";

import { createLogger } from "./log.js";

describe("createLogger", () => {
  it("writes JSON lines at or above the level, with bound and per-call fields", () => {
    const lines: string[] = [];
    const log = createLogger("info", (line) => lines.push(line)).child({ repo: "org/a" });
    log.debug("hidden");
    log.info("picked up", { issue: 3 });
    log.error("failed", { error: new Error("boom") });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ level: "info", msg: "picked up", repo: "org/a", issue: 3 });
    expect(parsed[1]).toMatchObject({ level: "error", error: { name: "Error", message: "boom" } });
    expect(typeof parsed[0]?.time).toBe("string");
  });
});
