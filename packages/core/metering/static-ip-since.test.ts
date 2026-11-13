import { describe, expect, it } from "vitest";
import { staticIpChargeableHours, staticIpHoursSince } from "./index";

// WPU-Y3. The retry of an unpaid static IP charge must reach every hour back to the first failed
// charge, not only the last three (the catch-up of the normal pass).
const D0 = new Date("2026-11-12T10:00:00.000Z"); // detached; Dhaka 16:00
const at = (iso: string): Date => new Date(iso);

describe("staticIpHoursSince", () => {
  it("gives every due hour from the start hour to the current one, oldest first", () => {
    expect(
      staticIpHoursSince(D0, at("2026-11-12T12:00:00.000Z"), at("2026-11-12T15:30:00.000Z")),
    ).toEqual(["2026-11-12T18", "2026-11-12T19", "2026-11-12T20", "2026-11-12T21"]);
  });

  it("never starts before the first chargeable hour (the first hour is free)", () => {
    const out = staticIpHoursSince(
      D0,
      at("2026-11-12T01:00:00.000Z"),
      at("2026-11-12T12:30:00.000Z"),
    );
    expect(out).toEqual(["2026-11-12T17", "2026-11-12T18"]);
  });

  it("reaches back more than three hours (the old window loses these)", () => {
    const now = at("2026-11-14T10:30:00.000Z");
    const old = staticIpChargeableHours(D0, now);
    expect(old).toHaveLength(3);
    const all = staticIpHoursSince(D0, at("2026-11-12T11:00:00.000Z"), now);
    expect(all.length).toBeGreaterThan(40);
    for (const hour of old) expect(all).toContain(hour);
    expect(new Set(all).size).toBe(all.length);
  });

  it("is empty when nothing is due, and for dates that are not dates", () => {
    expect(
      staticIpHoursSince(D0, at("2026-11-12T10:00:00.000Z"), at("2026-11-12T10:59:00.000Z")),
    ).toEqual([]);
    expect(staticIpHoursSince(new Date(Number.NaN), D0, at("2026-11-12T12:00:00.000Z"))).toEqual(
      [],
    );
  });

  it("is the three-hour window of the normal pass when started two hours back", () => {
    const now = at("2026-11-12T15:20:00.000Z");
    const start = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 - 2 * 3_600_000);
    expect(staticIpHoursSince(D0, start, now)).toEqual(staticIpChargeableHours(D0, now));
  });
});
