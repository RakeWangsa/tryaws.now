import { describe, expect, it } from "vitest";
import {
  DELEGATION_NOTICE_DAYS,
  DELEGATION_REMOVE_DAY,
  delegationRemovalAt,
  delegationStep,
  nameServersMatch,
} from "./delegation";

// WPU-D4 (audit C.24, spec 12): a zone that is not delegated within 14 days is removed after two notices
// (day 7 and day 12). Pure rules; the job that applies them is in functions/scheduler.

const DAY = 86_400_000;
const created = new Date("2026-11-01T06:00:00.000Z");
const at = (days: number, hours = 0) =>
  new Date(created.getTime() + days * DAY + hours * 3_600_000);

describe("nameServersMatch", () => {
  const zone = [
    "ns-1.awsdns-01.org",
    "ns-2.awsdns-02.com",
    "ns-3.awsdns-03.net",
    "ns-4.awsdns-04.co.uk",
  ];

  it("matches the same set, in any order, case and trailing dot", () => {
    expect(
      nameServersMatch(
        [
          "NS-4.awsdns-04.co.uk.",
          "ns-1.awsdns-01.org",
          "ns-3.awsdns-03.net.",
          "ns-2.AWSDNS-02.com",
        ],
        zone,
      ),
    ).toBe(true);
  });

  it("does not match a subset, a superset, another set or an empty answer", () => {
    expect(nameServersMatch(zone.slice(0, 3), zone)).toBe(false);
    expect(nameServersMatch([...zone, "ns.other.example"], zone)).toBe(false);
    expect(nameServersMatch(["ns1.registrar.example", "ns2.registrar.example"], zone)).toBe(false);
    expect(nameServersMatch([], zone)).toBe(false);
    // a zone without name servers (the create did not finish) matches nothing, even an empty answer
    expect(nameServersMatch([], [])).toBe(false);
    expect(nameServersMatch(zone, [])).toBe(false);
  });

  it("does not let a repeated name stand for a missing one", () => {
    expect(nameServersMatch([zone[0]!, zone[0]!, zone[0]!, zone[0]!], zone)).toBe(false);
  });
});

describe("delegationStep", () => {
  const step = (days: number, noticesSentAt: Date[] = [], hours = 0) =>
    delegationStep({ createdAt: created, now: at(days, hours), noticesSentAt });

  it("states the rule: notices on day 7 and 12, removal on day 14", () => {
    expect(DELEGATION_NOTICE_DAYS).toEqual([7, 12]);
    expect(DELEGATION_REMOVE_DAY).toBe(14);
    expect(delegationRemovalAt(created)).toEqual(at(14));
  });

  it("does nothing in the first 7 days", () => {
    expect(step(0)).toEqual({ kind: "none" });
    expect(step(6, [], 23)).toEqual({ kind: "none" });
  });

  it("sends the first notice from day 7, once", () => {
    expect(step(7)).toEqual({ kind: "notice", notice: 1, day: 7, missed: 1 });
    expect(step(7, [at(7)])).toEqual({ kind: "none" });
    expect(step(11, [at(7)])).toEqual({ kind: "none" });
  });

  it("sends the second notice from day 12, once", () => {
    expect(step(12, [at(7)])).toEqual({ kind: "notice", notice: 2, day: 12, missed: 1 });
    expect(step(12, [at(7), at(12)])).toEqual({ kind: "none" });
  });

  it("after downtime sends only the last notice that is due and counts the missed one", () => {
    expect(step(12, [])).toEqual({ kind: "notice", notice: 2, day: 12, missed: 2 });
  });

  it("removes from day 14, only after both notices and one full day after the second", () => {
    const both = [at(7), at(12)];
    expect(step(14, both)).toEqual({ kind: "remove" });
    expect(step(30, both)).toEqual({ kind: "remove" });
    // the second notice went out late: wait a day from it
    expect(step(14, [at(7), at(13, 12)])).toEqual({ kind: "none" });
    expect(step(14, [at(7), at(13, 12)], 13)).toEqual({ kind: "remove" });
  });

  it("never removes a zone that was not told twice: it tells first", () => {
    expect(step(14, [])).toEqual({ kind: "notice", notice: 2, day: 12, missed: 2 });
    expect(step(14, [at(7)])).toEqual({ kind: "notice", notice: 2, day: 12, missed: 1 });
  });

  it("refuses a time before the zone was created (clock skew) and an invalid date", () => {
    expect(delegationStep({ createdAt: created, now: at(-1), noticesSentAt: [] })).toEqual({
      kind: "none",
    });
    expect(
      delegationStep({ createdAt: new Date("x"), now: at(20), noticesSentAt: [at(7), at(12)] }),
    ).toEqual({ kind: "none" });
  });
});
