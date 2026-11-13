import { describe, expect, it } from "vitest";
import { unpaidDue } from "./index";

// WPU-Y3b finding 6. The scheduler runs every minute; the unpaid job runs in the first minutes of
// 07:00 in Dhaka only (a run key for each Dhaka day), so its cost does not grow with time.
describe("unpaidDue", () => {
  it("is due in the first five minutes of 07:00 Dhaka (01:00 UTC)", () => {
    for (const m of ["00", "01", "04"]) {
      expect(unpaidDue(new Date(`2026-11-11T01:${m}:30Z`))).toBe(true);
    }
  });
  it("is not due at any other minute of the day", () => {
    expect(unpaidDue(new Date("2026-11-11T01:05:00Z"))).toBe(false);
    expect(unpaidDue(new Date("2026-11-11T00:59:59Z"))).toBe(false);
    let due = 0;
    for (let m = 0; m < 1440; m += 1) {
      if (unpaidDue(new Date(Date.UTC(2026, 10, 11, 0, 0) + m * 60_000))) due += 1;
    }
    expect(due).toBe(5);
  });
  it("an invalid clock is never due (R16)", () => {
    expect(unpaidDue(new Date("nope"))).toBe(false);
  });
});
