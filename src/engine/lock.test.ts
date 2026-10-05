import { describe, expect, it } from "vitest";

import { KeyedLock } from "./lock.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("KeyedLock", () => {
  it("runs tasks for the same key one at a time, in order", async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`${name} start`);
      await tick();
      events.push(`${name} end`);
      return name;
    };
    const results = await Promise.all([lock.run("a", task("1")), lock.run("a", task("2"))]);
    expect(results).toEqual(["1", "2"]);
    expect(events).toEqual(["1 start", "1 end", "2 start", "2 end"]);
  });

  it("runs different keys concurrently", async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`${name} start`);
      await tick();
      events.push(`${name} end`);
    };
    await Promise.all([lock.run("a", task("a")), lock.run("b", task("b"))]);
    expect(events.slice(0, 2)).toEqual(["a start", "b start"]);
  });

  it("keeps going after a task fails", async () => {
    const lock = new KeyedLock();
    await expect(lock.run("a", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(lock.run("a", () => Promise.resolve(2))).resolves.toBe(2);
  });
});
