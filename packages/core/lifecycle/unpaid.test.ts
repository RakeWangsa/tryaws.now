import { describe, expect, it } from "vitest";
import {
  R13_APPROVAL_UNTIL,
  UNPAID_DELETE_AFTER_DAYS,
  UNPAID_SUSPEND_AFTER_DAYS,
  WALLET_LOW_DAYS,
  decideUnpaid,
  unpaidDayIndex,
  walletLowDue,
} from "./unpaid";

// WPU-Y3. Owner decision 2026-11-13, item 4: no grace. An unpaid metered charge suspends the resource
// after 1 day and deletes it at 7 days; R13 keeps admin approval for a deletion until 2026-12-01.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SINCE = new Date("2026-11-13T04:00:00.000Z");
const at = (ms: number): Date => new Date(SINCE.getTime() + ms);
// A date well after the approval period and one well before it.
const LATE = new Date("2027-01-01T00:00:00.000Z");
const EARLY = new Date("2026-11-01T00:00:00.000Z");

describe("the constants", () => {
  it("are one day and seven days", () => {
    expect(UNPAID_SUSPEND_AFTER_DAYS).toBe(1);
    expect(UNPAID_DELETE_AFTER_DAYS).toBe(7);
  });

  it("R13_APPROVAL_UNTIL is the end of 2026-12-01 in Dhaka (2026-12-02 00:00 +06:00)", () => {
    expect(R13_APPROVAL_UNTIL.toISOString()).toBe("2026-12-01T18:00:00.000Z");
  });
});

describe("decideUnpaid: the stage from dates (boundaries)", () => {
  const stage = (ms: number, approvalUntil: Date | null = LATE) =>
    decideUnpaid({ unpaidSince: SINCE, now: at(ms), approvalUntil: approvalUntil ?? null });

  it("day 0: the instant of the first failed charge is only a retry, nothing is suspended", () => {
    expect(stage(0)).toEqual({ stage: "retry" });
  });

  it("just before 1 day: still only a retry", () => {
    expect(stage(DAY - 1)).toEqual({ stage: "retry" });
  });

  it("exactly 1 day: suspended, 6 days left", () => {
    expect(stage(DAY)).toMatchObject({ stage: "suspended", daysLeft: 6 });
  });

  it("day 6: suspended, 1 day left (also one millisecond before day 7)", () => {
    expect(stage(6 * DAY)).toMatchObject({ stage: "suspended", daysLeft: 1 });
    expect(stage(7 * DAY - 1)).toMatchObject({ stage: "suspended", daysLeft: 1 });
  });

  it("exactly 7 days: deletion is due", () => {
    expect(stage(7 * DAY)).toMatchObject({ stage: "deletion" });
  });

  it("after 7 days it stays at deletion", () => {
    expect(stage(30 * DAY)).toMatchObject({ stage: "deletion" });
  });

  it("the days left count down from 6 to 1 on days 1 to 6", () => {
    const left = [1, 2, 3, 4, 5, 6].map((d) => {
      const s = stage(d * DAY + 5 * HOUR);
      return s.stage === "suspended" ? s.daysLeft : -1;
    });
    expect(left).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("the suspended stage names the instant of the deletion (unpaid since + 7 days)", () => {
    const s = stage(2 * DAY);
    expect(s.stage === "suspended" && s.deleteAt.toISOString()).toBe(at(7 * DAY).toISOString());
  });

  it("no unpaid charge, or a date that is not a date, decides nothing (R16)", () => {
    expect(decideUnpaid({ unpaidSince: null, now: SINCE, approvalUntil: LATE })).toEqual({
      stage: "none",
    });
    expect(
      decideUnpaid({ unpaidSince: new Date(Number.NaN), now: SINCE, approvalUntil: LATE }),
    ).toEqual({ stage: "none" });
    expect(
      decideUnpaid({ unpaidSince: SINCE, now: new Date(Number.NaN), approvalUntil: LATE }),
    ).toEqual({ stage: "none" });
  });

  it("a clock that is before the first failed charge never suspends or deletes", () => {
    expect(stage(-5 * DAY)).toEqual({ stage: "retry" });
  });
});

describe("decideUnpaid: R13, admin approval until 2026-12-01", () => {
  const due = new Date(SINCE.getTime() + 7 * DAY);
  const atDeletion = (now: Date, approvalUntil: Date | null) =>
    decideUnpaid({ unpaidSince: new Date(now.getTime() - 7 * DAY), now, approvalUntil });

  it("on the last millisecond before the end date the deletion needs an admin", () => {
    const s = atDeletion(new Date(R13_APPROVAL_UNTIL.getTime() - 1), R13_APPROVAL_UNTIL);
    expect(s).toMatchObject({ stage: "deletion", approvalRequired: true });
  });

  it("at the end date and after it no approval is needed", () => {
    expect(atDeletion(R13_APPROVAL_UNTIL, R13_APPROVAL_UNTIL)).toMatchObject({
      stage: "deletion",
      approvalRequired: false,
    });
    expect(
      atDeletion(new Date(R13_APPROVAL_UNTIL.getTime() + 1), R13_APPROVAL_UNTIL),
    ).toMatchObject({ approvalRequired: false });
  });

  it("an end date that cannot be read means approval is needed (R16)", () => {
    expect(atDeletion(LATE, null)).toMatchObject({ stage: "deletion", approvalRequired: true });
    expect(atDeletion(LATE, new Date(Number.NaN))).toMatchObject({ approvalRequired: true });
  });

  it("the deletion instant is carried", () => {
    const s = decideUnpaid({ unpaidSince: SINCE, now: due, approvalUntil: EARLY });
    expect(s.stage === "deletion" && s.deleteAt.toISOString()).toBe(due.toISOString());
  });
});

describe("unpaidDayIndex: one email for each unpaid day", () => {
  it("counts whole days since the first failed charge", () => {
    expect(unpaidDayIndex(SINCE, at(0))).toBe(0);
    expect(unpaidDayIndex(SINCE, at(DAY - 1))).toBe(0);
    expect(unpaidDayIndex(SINCE, at(DAY))).toBe(1);
    expect(unpaidDayIndex(SINCE, at(7 * DAY))).toBe(7);
  });

  it("is 0 for a clock before the start and for a date that is not a date", () => {
    expect(unpaidDayIndex(SINCE, at(-DAY))).toBe(0);
    expect(unpaidDayIndex(new Date(Number.NaN), SINCE)).toBe(0);
  });
});

describe("walletLowDue: the reminder before a charge", () => {
  it("is for 3 days and 1 day before the charge", () => {
    expect(WALLET_LOW_DAYS).toEqual([3, 1]);
  });

  it("is due on day 3 and day 1 when the wallet cannot cover the charge", () => {
    expect(walletLowDue({ day: 3, balanceMinor: 99n, amountMinor: 100n })).toBe(true);
    expect(walletLowDue({ day: 1, balanceMinor: 0n, amountMinor: 100n })).toBe(true);
  });

  it("is not due when the balance covers the charge exactly or more", () => {
    expect(walletLowDue({ day: 3, balanceMinor: 100n, amountMinor: 100n })).toBe(false);
    expect(walletLowDue({ day: 1, balanceMinor: 101n, amountMinor: 100n })).toBe(false);
  });

  it("is not due on the other reminder days (7)", () => {
    expect(walletLowDue({ day: 7, balanceMinor: 0n, amountMinor: 100n })).toBe(false);
  });

  it("is not due when the amount is unknown or zero (nothing to cover)", () => {
    expect(walletLowDue({ day: 3, balanceMinor: 0n, amountMinor: null })).toBe(false);
    expect(walletLowDue({ day: 3, balanceMinor: 0n, amountMinor: 0n })).toBe(false);
  });
});
