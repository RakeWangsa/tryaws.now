import { describe, expect, it } from "vitest";
import { staticIpFeeOf } from "./static-ip-fee.ts";

// WPU-M1: the badge of the screens follows the same rule as the charge: more than one hour unattached.
const NOW = new Date("2026-11-12T11:01:00.000Z");
const DETACHED = "2026-11-12T10:00:00.000Z";

describe("staticIpFeeOf", () => {
  it("an attached IP is free", () => {
    expect(staticIpFeeOf({}, "74", NOW)).toEqual({ hourMinor: "74", charging: false });
    expect(staticIpFeeOf({ staticIpAttached: true, detachedAt: null }, "74", NOW).charging).toBe(
      false,
    );
  });
  it("unattached for exactly one hour is not charging; one minute more is", () => {
    const cfg = { staticIpAttached: false, detachedAt: DETACHED };
    expect(staticIpFeeOf(cfg, "74", new Date("2026-11-12T11:00:00.000Z")).charging).toBe(false);
    expect(staticIpFeeOf(cfg, "74", NOW).charging).toBe(true);
  });
  it("a detached IP without a readable time is not shown as charging (it is not charged)", () => {
    expect(staticIpFeeOf({ staticIpAttached: false }, "74", NOW).charging).toBe(false);
    expect(staticIpFeeOf({ staticIpAttached: false, detachedAt: "x" }, "74", NOW).charging).toBe(
      false,
    );
  });
  it("no price keeps the null", () => {
    expect(staticIpFeeOf({ staticIpAttached: false, detachedAt: DETACHED }, null, NOW)).toEqual({
      hourMinor: null,
      charging: true,
    });
  });
});
