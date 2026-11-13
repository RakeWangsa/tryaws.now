import { describe, expect, it } from "vitest";
import { createManualClock } from "../operations/manual-clock";
import { DEFAULT_LIFECYCLE_CONFIG } from "./config";
import { decideSubscription, type DecisionView } from "./decide";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const END = new Date("2026-12-01T00:00:00.000Z");
const cfg = DEFAULT_LIFECYCLE_CONFIG;

function view(over: Partial<DecisionView> = {}): DecisionView {
  return {
    status: "active",
    periodEnd: END,
    autoRenew: false,
    resourceState: "active",
    destroyedAt: null,
    ...over,
  };
}
const at = (ms: number): Date => new Date(END.getTime() + ms);

describe("decideSubscription: active", () => {
  it("does nothing more than 7 days before the end", () => {
    expect(decideSubscription(view(), at(-7 * DAY - 1), cfg)).toEqual({ type: "none" });
  });
  it("sends the reminder of day 7, 3 and 1 from the exact instant", () => {
    expect(decideSubscription(view(), at(-7 * DAY), cfg)).toEqual({ type: "remind", day: 7 });
    expect(decideSubscription(view(), at(-3 * DAY - 1), cfg)).toEqual({ type: "remind", day: 7 });
    expect(decideSubscription(view(), at(-3 * DAY), cfg)).toEqual({ type: "remind", day: 3 });
    expect(decideSubscription(view(), at(-1 * DAY), cfg)).toEqual({ type: "remind", day: 1 });
    expect(decideSubscription(view(), at(-1), cfg)).toEqual({ type: "remind", day: 1 });
  });
  it("a late run sends only the latest reminder, never the earlier ones", () => {
    expect(decideSubscription(view(), at(-2 * DAY), cfg)).toEqual({ type: "remind", day: 3 });
  });
  it("at the period end it asks for a renewal only when auto-renew is on", () => {
    expect(decideSubscription(view({ autoRenew: true }), at(0), cfg)).toEqual({
      type: "period_end",
      tryRenew: true,
    });
    expect(decideSubscription(view({ autoRenew: false }), at(0), cfg)).toEqual({
      type: "period_end",
      tryRenew: false,
    });
  });
});

describe("decideSubscription: grace", () => {
  it("waits during the 48 hours when auto-renew is off", () => {
    expect(decideSubscription(view({ status: "grace" }), at(47 * HOUR), cfg)).toEqual({
      type: "none",
    });
  });
  it("retries the renewal on every run while auto-renew is on", () => {
    const v = view({ status: "grace", autoRenew: true });
    expect(decideSubscription(v, at(1 * HOUR), cfg)).toEqual({ type: "retry_renew" });
    expect(decideSubscription(v, at(48 * HOUR - 1), cfg)).toEqual({ type: "retry_renew" });
  });
  it("retains at period end + 48 hours, even with auto-renew on", () => {
    expect(decideSubscription(view({ status: "grace" }), at(48 * HOUR), cfg)).toEqual({
      type: "retain",
    });
    expect(
      decideSubscription(view({ status: "grace", autoRenew: true }), at(48 * HOUR), cfg),
    ).toEqual({ type: "retain" });
  });
  it("uses the configured grace length", () => {
    const short = { ...cfg, graceHours: 1 };
    expect(decideSubscription(view({ status: "grace" }), at(HOUR), short)).toEqual({
      type: "retain",
    });
  });
});

describe("decideSubscription: retained and ended", () => {
  const destroyedAt = at(50 * HOUR);
  it("waits while the resource is not destroyed yet (approval may still be open)", () => {
    expect(
      decideSubscription(
        view({ status: "retained", resourceState: "suspended" }),
        at(30 * DAY),
        cfg,
      ),
    ).toEqual({ type: "ensure_retention_operations" });
  });
  it("ends 14 days after the destroy, not before", () => {
    const v = view({ status: "retained", resourceState: "destroyed", destroyedAt });
    expect(decideSubscription(v, new Date(destroyedAt.getTime() + 14 * DAY - 1), cfg)).toEqual({
      type: "none",
    });
    expect(decideSubscription(v, new Date(destroyedAt.getTime() + 14 * DAY), cfg)).toEqual({
      type: "end",
    });
  });
  it("a destroyed resource with no destroy time never ends (fail closed)", () => {
    const v = view({ status: "retained", resourceState: "destroyed", destroyedAt: null });
    expect(decideSubscription(v, at(400 * DAY), cfg)).toEqual({ type: "none" });
  });
  it("an ended subscription needs nothing", () => {
    expect(decideSubscription(view({ status: "ended" }), at(900 * DAY), cfg)).toEqual({
      type: "none",
    });
  });
});

describe("decideSubscription: guards", () => {
  it("an invalid clock instant decides nothing (R16)", () => {
    expect(decideSubscription(view(), new Date(Number.NaN), cfg)).toEqual({ type: "none" });
  });
  it("a resource that is creating or failed is left alone", () => {
    expect(decideSubscription(view({ resourceState: "creating" }), at(DAY), cfg)).toEqual({
      type: "none",
    });
    expect(decideSubscription(view({ resourceState: "failed" }), at(DAY), cfg)).toEqual({
      type: "none",
    });
  });
  it("works on the manual clock at any step", () => {
    const clock = createManualClock(at(-8 * DAY));
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const a = decideSubscription(view(), clock.now(), cfg);
      seen.push(a.type === "remind" ? `r${a.day}` : a.type);
      clock.advance(DAY / 1000);
    }
    expect(seen).toEqual([
      "none",
      "r7",
      "r7",
      "r7",
      "r7",
      "r3",
      "r3",
      "r1",
      "period_end",
      "period_end",
      "period_end",
      "period_end",
    ]);
  });
});

// WPU-Y9 finding 8: a grace that starts when a rate hold is released (graceFrom) runs from there, so the
// days of the hold do not use it up and nobody is retained the moment the hold ends.
describe("decideSubscription: grace from the release of a rate hold", () => {
  const released = new Date(END.getTime() + 10 * DAY); // a hold of ten days, released here
  const grace = (over: Partial<DecisionView> = {}) =>
    view({ status: "grace", autoRenew: true, graceFrom: released, ...over });
  it("without graceFrom the grace runs from the period end, as before", () => {
    expect(
      decideSubscription(view({ status: "grace", autoRenew: true }), at(10 * DAY), cfg),
    ).toEqual({ type: "retain" });
  });
  it("with graceFrom it keeps retrying until graceHours after the release", () => {
    expect(decideSubscription(grace(), released, cfg)).toEqual({ type: "retry_renew" });
    expect(decideSubscription(grace(), new Date(released.getTime() + 48 * HOUR - 1), cfg)).toEqual({
      type: "retry_renew",
    });
    expect(decideSubscription(grace(), new Date(released.getTime() + 48 * HOUR), cfg)).toEqual({
      type: "retain",
    });
  });
  it("a graceFrom before the period end, or one that cannot be read, changes nothing", () => {
    const early = grace({ graceFrom: new Date(END.getTime() - DAY) });
    expect(decideSubscription(early, at(48 * HOUR), cfg)).toEqual({ type: "retain" });
    const bad = grace({ graceFrom: new Date("nope") });
    expect(decideSubscription(bad, at(48 * HOUR), cfg)).toEqual({ type: "retain" });
  });
});
