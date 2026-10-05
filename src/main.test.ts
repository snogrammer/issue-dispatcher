import { describe, expect, it, vi } from "vitest";

import { main } from "./main.js";

describe("main", () => {
  it("logs a startup message", () => {
    const log = vi.fn();
    main(log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("claude-dispatcher starting"));
  });
});
