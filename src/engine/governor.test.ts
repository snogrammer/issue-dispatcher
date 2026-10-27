import { describe, expect, it } from "vitest";

import { StateStore } from "../state/store.js";
import { Governor } from "./governor.js";

const LIMITS = { backoffBaseMin: 15, backoffMaxMin: 60, pickupThreshold: 0.9 };
const T0 = new Date("2026-06-01T00:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function setup() {
  const clock = { now: T0 };
  const store = StateStore.inMemory({ now: () => clock.now });
  const governor = new Governor(store, LIMITS, () => clock.now);
  return { clock, store, governor };
}

describe("hard pause", () => {
  it("pauses everything until a known reset time", () => {
    const { governor, store, clock } = setup();
    const result = governor.observe({
      kind: "rate_limited",
      rateLimit: { status: "rejected", resetsAt: at(120) },
    });
    expect(result).toEqual({ pauseStarted: true, pausedUntil: at(120) });
    expect(store.getGovernor().backoffLevel).toBe(0);
    expect(governor.isPaused()).toBe(true);
    expect(governor.pickupsPaused()).toBe(true);

    clock.now = at(120);
    expect(governor.isPaused()).toBe(false);
    expect(store.getGovernor().pausedUntil).toBeNull();
  });

  it("backs off exponentially without a reset time, capped, and resets after a success", () => {
    const { governor, store, clock } = setup();
    const pauses: Date[] = [];
    for (let i = 0; i < 4; i++) {
      const { pausedUntil } = governor.observe({ kind: "rate_limited" });
      if (pausedUntil) {
        pauses.push(pausedUntil);
        clock.now = pausedUntil;
      }
    }
    // 15, 30, 60, then capped at 60 minutes, each from the end of the last pause.
    expect(pauses).toEqual([at(15), at(45), at(105), at(165)]);
    expect(store.getGovernor().backoffLevel).toBe(4);

    governor.observe({ kind: "success" });
    expect(store.getGovernor().backoffLevel).toBe(0);
  });

  it("records why it paused, and lifts only an auth pause on restart", () => {
    const { governor, store, clock } = setup();
    governor.observe({ kind: "auth_failed" });
    expect(store.getGovernor()).toMatchObject({ pausedUntil: at(15), pauseReason: "auth" });

    governor.liftAuthPause();
    expect(store.getGovernor()).toMatchObject({
      pausedUntil: null,
      pauseReason: null,
      backoffLevel: 1,
    });

    governor.observe({ kind: "rate_limited", rateLimit: { status: "rejected", resetsAt: at(60) } });
    governor.liftAuthPause();
    expect(store.getGovernor()).toMatchObject({ pausedUntil: at(60), pauseReason: "usage" });

    clock.now = at(60);
    expect(governor.isPaused()).toBe(false);
    expect(store.getGovernor().pauseReason).toBeNull();
  });

  it("treats a reset time in the past as unknown", () => {
    const { governor } = setup();
    const { pausedUntil } = governor.observe({
      kind: "rate_limited",
      rateLimit: { status: "rejected", resetsAt: at(-5) },
    });
    expect(pausedUntil).toEqual(at(15));
  });

  it("reports that a pause started only once", () => {
    const { governor } = setup();
    expect(governor.observe({ kind: "rate_limited" }).pauseStarted).toBe(true);
    expect(governor.observe({ kind: "rate_limited" }).pauseStarted).toBe(false);
  });
});

describe("pickup pause", () => {
  it("stops pickups (not runs) on a warning, until the window resets", () => {
    const { governor, clock } = setup();
    governor.observe({
      kind: "success",
      rateLimit: { status: "allowed_warning", resetsAt: at(90), utilization: 0.8 },
    });
    expect(governor.isPaused()).toBe(false);
    expect(governor.pickupsPaused()).toBe(true);
    clock.now = at(90);
    expect(governor.pickupsPaused()).toBe(false);
  });

  it("stops pickups when any usage window crosses the threshold, until the latest reset", () => {
    const { governor, store } = setup();
    governor.observe({
      kind: "success",
      rateLimit: {
        status: "allowed",
        windows: [
          { name: "five_hour", utilization: 0.95, resetsAt: at(60) },
          { name: "seven_day", utilization: 0.92, resetsAt: at(3000) },
          { name: "other", utilization: 0.1, resetsAt: at(9000) },
        ],
      },
    });
    expect(store.getGovernor().pickupPausedUntil).toEqual(at(3000));
  });

  it("lifts the pickup pause when fresh info is under the threshold", () => {
    const { governor } = setup();
    governor.observe({
      kind: "success",
      rateLimit: { status: "allowed", utilization: 0.95, resetsAt: at(60) },
    });
    expect(governor.pickupsPaused()).toBe(true);
    governor.observe({
      kind: "success",
      rateLimit: {
        status: "allowed",
        utilization: 0.4,
        resetsAt: at(60),
        windows: [{ name: "five_hour", utilization: 0.4, resetsAt: at(60) }],
      },
    });
    expect(governor.pickupsPaused()).toBe(false);
  });

  it("ignores runs that say nothing about limits", () => {
    const { governor } = setup();
    governor.observe({ kind: "error" });
    expect(governor.pickupsPaused()).toBe(false);
  });
});
