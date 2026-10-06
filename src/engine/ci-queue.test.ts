import { describe, expect, it } from "vitest";

import { FakeGitea } from "../../test/helpers/fake-gitea.js";
import { createLogger } from "../log.js";
import { CiQueue } from "./ci-queue.js";

const a = { owner: "org", name: "a" };
const b = { owner: "org", name: "b" };

function gitea() {
  const fake = new FakeGitea("bot");
  fake.addRepo("org/a");
  fake.addRepo("org/b");
  return fake;
}

describe("CiQueue", () => {
  it("counts queued, running and waiting runs across repos", async () => {
    const fake = gitea();
    fake.addRun("org/a", "s1", "queued");
    fake.addRun("org/a", "s2", "in_progress");
    fake.addRun("org/b", "s3", "waiting");
    fake.addRun("org/b", "s4", "completed", "success");

    expect(await new CiQueue(fake, 4).load([a, b])).toEqual({ active: 3, busy: false });
    expect(await new CiQueue(fake, 3).load([a, b])).toEqual({ active: 3, busy: true });
  });

  it("is not busy when the counts can't be read, and warns once until it recovers", async () => {
    const fake = gitea();
    fake.countFailure = true;
    const lines: string[] = [];
    const queue = new CiQueue(fake, 1, createLogger("info", { write: (line) => lines.push(line) }));
    expect(await queue.load([a])).toEqual({ active: 0, busy: false });
    await queue.load([a]);
    fake.countFailure = false;
    await queue.load([a]);
    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual([
      "can't count Actions runs; ignoring this repo's CI load",
      "counting Actions runs again",
    ]);
  });
});
