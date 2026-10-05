import { describe, expect, it } from "vitest";

import { applyStreamLine, emptyStreamState } from "./stream.js";

function parse(...messages: (object | string)[]) {
  const state = emptyStreamState();
  for (const message of messages) {
    applyStreamLine(state, typeof message === "string" ? message : JSON.stringify(message));
  }
  return state;
}

describe("applyStreamLine", () => {
  it("collects session, rate limit and result from a stream", () => {
    const state = parse(
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [] }, session_id: "s1" },
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1791255600, rateLimitType: "five_hour" },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 3,
        total_cost_usd: 0.05,
        structured_output: { ok: true },
        result: '{"ok":true}',
        usage: {
          input_tokens: 18,
          cache_creation_input_tokens: 20921,
          cache_read_input_tokens: 19858,
          output_tokens: 297,
        },
      },
    );
    expect(state).toEqual({
      sessionId: "s1",
      rateLimit: { status: "allowed", resetsAt: new Date(1791255600_000), type: "five_hour" },
      result: {
        subtype: "success",
        isError: false,
        structuredOutput: { ok: true },
        resultText: '{"ok":true}',
        errors: [],
        numTurns: 3,
        costUsd: 0.05,
        inputTokens: 40797,
        outputTokens: 297,
      },
      malformedLines: 0,
    });
  });

  it("keeps the latest rate-limit info and accepts millisecond timestamps", () => {
    const state = parse(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", utilization: 0.9 },
      },
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1791255600_000 },
      },
    );
    expect(state.rateLimit).toEqual({ status: "rejected", resetsAt: new Date(1791255600_000) });
  });

  it("ignores rate-limit events with an unknown status", () => {
    expect(
      parse({ type: "rate_limit_event", rate_limit_info: { status: "weird" } }).rateLimit,
    ).toBe(undefined);
  });

  it("reads error results", () => {
    const state = parse({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      errors: ["Reached maximum number of turns (1)", 42],
    });
    expect(state.result).toEqual({
      subtype: "error_max_turns",
      isError: true,
      errors: ["Reached maximum number of turns (1)"],
    });
  });

  it("counts malformed lines and skips blank ones", () => {
    const state = parse("not json", "", "[1,2]", "   ");
    expect(state.malformedLines).toBe(2);
    expect(state.result).toBeUndefined();
  });
});
