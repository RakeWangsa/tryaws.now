import { describe, expect, it } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG, LIFECYCLE_SETTING_KEYS, parseLifecycleConfig } from "./config";

describe("lifecycle config", () => {
  it("holds the values of section 11", () => {
    expect(DEFAULT_LIFECYCLE_CONFIG).toEqual({
      graceHours: 48,
      retentionDays: 14,
      reminderDays: [7, 3, 1],
      smsReminderDay: 1,
      termDays: 30,
    });
    expect(Object.isFrozen(DEFAULT_LIFECYCLE_CONFIG)).toBe(true);
  });

  it("takes the defaults when no setting row exists", () => {
    expect(parseLifecycleConfig(new Map())).toEqual(DEFAULT_LIFECYCLE_CONFIG);
  });

  it("reads a setting row of each key", () => {
    const rows = new Map<string, unknown>([
      [LIFECYCLE_SETTING_KEYS.graceHours, 1],
      [LIFECYCLE_SETTING_KEYS.retentionDays, 2],
      [LIFECYCLE_SETTING_KEYS.termDays, 3],
    ]);
    expect(parseLifecycleConfig(rows)).toMatchObject({
      graceHours: 1,
      retentionDays: 2,
      termDays: 3,
    });
  });

  it("refuses a value that is not a positive whole number (R16)", () => {
    for (const bad of [0, -1, 1.5, "48", null, Number.NaN, 1e9]) {
      expect(() =>
        parseLifecycleConfig(new Map<string, unknown>([[LIFECYCLE_SETTING_KEYS.graceHours, bad]])),
      ).toThrow("lifecycle config: graceHours is not valid");
    }
  });
});
