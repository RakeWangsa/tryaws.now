import { describe, expect, it } from "vitest";
import { resolveProduct } from "./instance";
import {
  checkLbTargets,
  parseLoadBalancerConfig,
  resolveLoadBalancer,
  type TargetCandidate,
} from "./load-balancer";

const ME = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const cand = (over: Partial<TargetCandidate> = {}): TargetCandidate => ({
  id: T1,
  customerId: ME,
  family: "linux_instance",
  state: "active",
  region: "ap-southeast-1",
  ...over,
});
const check = (requested: string[], candidates: (TargetCandidate | null)[]) =>
  checkLbTargets({ customerId: ME, region: "ap-southeast-1", requested, candidates });

describe("checkLbTargets (pure)", () => {
  it("accepts the customer's own active instances in the same Region", () => {
    expect(check([T1, T2], [cand(), cand({ id: T2, family: "windows_instance" })])).toEqual({
      ok: true,
      value: [T1, T2],
    });
  });

  it("another customer's instance gives the same answer as a missing one (R8)", () => {
    const foreign = check([T1], [cand({ customerId: OTHER })]);
    const missing = check([T1], [null]);
    expect(foreign).toEqual(missing);
    expect(foreign.ok).toBe(false);
  });

  it("refuses another Region, a non-instance, a non-active state, duplicates, none and too many", () => {
    const bad = (r: ReturnType<typeof check>) => expect(r.ok).toBe(false);
    bad(check([T1], [cand({ region: "eu-west-1" })]));
    bad(check([T1], [cand({ family: "database" })]));
    bad(check([T1], [cand({ state: "suspended" })]));
    bad(check([T1, T1], [cand()]));
    bad(check([], []));
    bad(check(["not-a-uuid"], [cand({ id: "not-a-uuid" })]));
    const many = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    bad(
      check(
        many,
        many.map((id) => cand({ id })),
      ),
    );
  });

  it("a candidate that was not requested does not count", () => {
    expect(check([T1], [cand({ id: T2 })]).ok).toBe(false);
  });
});

describe("resolveLoadBalancer takes only checked targets", () => {
  const row = {
    id: T1,
    family: "load_balancer",
    awsId: "lb",
    platform: null,
    region: "ap-southeast-1",
    specs: {},
    awsPriceUsd: "18.0000",
    billingUnit: "month",
    featureFlag: "load_balancer",
    active: true,
  };
  it("writes the checked ids, never the ones of the config, and resolveProduct refuses the family", async () => {
    const config = {
      productId: T1,
      region: "ap-southeast-1",
      displayName: "lb",
      targetIds: [OTHER],
    };
    const checked = checkLbTargets({
      customerId: ME,
      region: "ap-southeast-1",
      requested: [T2],
      candidates: [cand({ id: T2 })],
    });
    if (!checked.ok) throw new Error("check");
    const r = resolveLoadBalancer(config, row, checked.value);
    expect(r).toMatchObject({ ok: true, value: { resourceConfig: { targetIds: [T2] } } });
    expect(await resolveProduct("load_balancer", config, async () => row)).toEqual({
      ok: false,
      error: "validation",
      fields: { family: "unsupported" },
    });
  });
});

describe("parseLoadBalancerConfig", () => {
  it("keeps the known fields and drops unknown keys and awsName", () => {
    const r = parseLoadBalancerConfig({
      productId: T1,
      region: "ap-southeast-1",
      displayName: "Web LB",
      targetIds: [T2],
      awsName: "x",
      extra: 1,
    });
    expect(r).toEqual({
      ok: true,
      value: { productId: T1, region: "ap-southeast-1", displayName: "Web LB", targetIds: [T2] },
    });
  });
  it("collects invalid fields", () => {
    const r = parseLoadBalancerConfig({
      productId: "x",
      region: "r",
      displayName: "<b>",
      targetIds: "no",
    });
    expect(r).toMatchObject({
      ok: false,
      fields: {
        productId: "invalid",
        region: "invalid",
        displayName: "invalid",
        targetIds: "invalid",
      },
    });
  });
});
