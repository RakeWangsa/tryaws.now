// WPU-S3: the pure rules that close the gaming path of a downgrade at the next renewal. Run without a
// database; the proofs that need one are in plan-change.db.test.ts.
import { describe, expect, it } from "vitest";
import { PLAN_APPLY_KINDS, planApplyInFlight, planFailedFor, readPlanFailure } from "./plan-change";

const B = "0190aaaa-0000-7000-8000-0000000000b1";
const C = "0190aaaa-0000-7000-8000-0000000000c1";

describe("planApplyInFlight (WPU-S3)", () => {
  it("is true for a queued, running, waiting or approval-waiting apply of either family", () => {
    for (const kind of PLAN_APPLY_KINDS) {
      for (const state of ["queued", "running", "waiting", "needs_approval"]) {
        expect(planApplyInFlight([{ kind, state }])).toBe(true);
      }
    }
  });
  it("is false for finished or failed applies and for every other kind", () => {
    expect(PLAN_APPLY_KINDS).toEqual(["scale_container", "change_cdn_bundle"]);
    for (const state of ["succeeded", "failed", "needs_attention", "cancelled", "rejected"]) {
      expect(planApplyInFlight([{ kind: "scale_container", state }])).toBe(false);
    }
    expect(planApplyInFlight([{ kind: "reboot", state: "running" }])).toBe(false);
    expect(planApplyInFlight([])).toBe(false);
  });
  it("finds the apply among other operations", () => {
    expect(
      planApplyInFlight([
        { kind: "rename", state: "succeeded" },
        { kind: "change_cdn_bundle", state: "queued" },
      ]),
    ).toBe(true);
  });
});

describe("readPlanFailure and planFailedFor (WPU-S3)", () => {
  it("reads code, productId and period of the mark; anything malformed reads as none", () => {
    const period = "2026-11-12T00:00:00.000Z";
    expect(
      readPlanFailure({ pendingPlanFailed: { code: "conflict", productId: B, period } }),
    ).toEqual({ code: "conflict", productId: B, period });
    expect(readPlanFailure({ pendingPlanFailed: { code: "conflict" } })).toEqual({
      code: "conflict",
      productId: null,
      period: null,
    });
    expect(readPlanFailure({})).toBeNull();
    expect(readPlanFailure({ pendingPlanFailed: null })).toBeNull();
    expect(readPlanFailure({ pendingPlanFailed: "x" })).toBeNull();
    expect(readPlanFailure(null)).toBeNull();
  });

  it("blocks the SAME product while the mark exists, allows a DIFFERENT one", () => {
    const config = { pendingPlanFailed: { code: "conflict", productId: B, period: "p" } };
    expect(planFailedFor(config, B)).toBe(true);
    expect(planFailedFor(config, C)).toBe(false);
    expect(planFailedFor({}, B)).toBe(false);
  });

  it("a mark written before WPU-S3 (code only) counts for the pending plan of the config", () => {
    const old = { pendingPlan: { productId: B }, pendingPlanFailed: { code: "conflict" } };
    expect(planFailedFor(old, B)).toBe(true);
    expect(planFailedFor(old, C)).toBe(false);
    expect(planFailedFor({ pendingPlanFailed: { code: "x" } }, B)).toBe(false);
  });
});
