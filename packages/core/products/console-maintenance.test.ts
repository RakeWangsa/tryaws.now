import { describe, expect, it } from "vitest";
import { checkedMaintenanceWindow, windowsOverlap } from "./console";

// WPU-G9. The preferred maintenance window of a database: ddd:hh24:mi-ddd:hh24:mi, UTC, at least 30
// minutes, and it must not overlap the backup window (Lightsail refuses an overlap).
describe("checkedMaintenanceWindow", () => {
  it("accepts a normal window and one that crosses midnight or the week", () => {
    expect(checkedMaintenanceWindow("tue:17:00-tue:17:30")).toBe("tue:17:00-tue:17:30");
    expect(checkedMaintenanceWindow("sat:23:30-sun:00:30")).toBe("sat:23:30-sun:00:30");
    expect(checkedMaintenanceWindow("sun:00:00-sun:01:00")).toBe("sun:00:00-sun:01:00");
  });
  it("refuses shorter than 30 minutes, bad days, bad times, upper case and other types", () => {
    for (const bad of [
      "tue:17:00-tue:17:20",
      "tue:17:00-tue:17:00",
      "xyz:17:00-tue:18:00",
      "tue:25:00-tue:26:00",
      "Tue:17:00-Tue:18:00",
      "17:00-18:00",
      "tue:17:00-tue:18:00; drop",
      5,
      null,
    ]) {
      expect(checkedMaintenanceWindow(bad)).toBeNull();
    }
  });
});

describe("windowsOverlap", () => {
  it("a daily backup window overlaps a weekly window on the same hours of that day", () => {
    expect(windowsOverlap("17:00-18:00", "tue:17:30-tue:18:30")).toBe(true);
    expect(windowsOverlap("17:00-18:00", "tue:18:00-tue:19:00")).toBe(false);
    expect(windowsOverlap("22:00-23:00", "tue:09:00-tue:10:00")).toBe(false);
  });
  it("handles windows across midnight", () => {
    expect(windowsOverlap("23:30-00:30", "wed:00:00-wed:01:00")).toBe(true);
    expect(windowsOverlap("23:30-00:30", "wed:01:00-wed:02:00")).toBe(false);
  });
});
