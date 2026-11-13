import { describe, expect, it } from "vitest";
import { renewalConfirmable, renewalRecheckVerdict, sameRenewalTarget } from "./renewal-recheck";

// WPU-X3 (b). The rule of the admin action "registry confirmed not renewed": only a final answer that is not
// SUCCESSFUL (FAILED or ERROR) for the saved RenewDomain operation, with a fresh expiry equal to the pre-renewal expiry
// to the millisecond, refunds. Everything else keeps the renewal as it is, with a reason.
const BEFORE = "2031-03-04T05:06:07.890Z";
const payload = { currentExpiryYear: 2031, currentExpiresAt: BEFORE };
const at = (iso: string) => new Date(iso);

describe("renewalRecheckVerdict", () => {
  it.each(["failed", "error"] as const)(
    "%s with the exact unchanged expiry is confirmed not renewed",
    (status) => {
      expect(renewalRecheckVerdict({ status, liveExpiresAt: at(BEFORE), payload })).toEqual({
        verdict: "unrenewed",
      });
    },
  );

  it("SUCCESSFUL is renewed, whatever the expiry says", () => {
    expect(
      renewalRecheckVerdict({ status: "successful", liveExpiresAt: at(BEFORE), payload }),
    ).toEqual({ verdict: "kept", reason: "registry_renewed" });
  });

  it("an operation still in progress may still renew: kept", () => {
    expect(
      renewalRecheckVerdict({ status: "in_progress", liveExpiresAt: at(BEFORE), payload }),
    ).toEqual({ verdict: "kept", reason: "renewal_in_progress" });
  });

  it("a final error with a later expiry year went through: kept as renewed", () => {
    expect(
      renewalRecheckVerdict({
        status: "error",
        liveExpiresAt: at("2032-03-04T05:06:07.890Z"),
        payload,
      }),
    ).toEqual({ verdict: "kept", reason: "registry_renewed" });
  });

  it.each([
    "2031-03-04T05:06:07.891Z",
    "2031-03-04T05:06:07.000Z",
    "2031-12-31T00:00:00.000Z",
    "2030-03-04T05:06:07.890Z",
  ])("a final error with another instant (%s) is not proof: kept", (live) => {
    expect(renewalRecheckVerdict({ status: "failed", liveExpiresAt: at(live), payload })).toEqual({
      verdict: "kept",
      reason: "expiry_changed",
    });
  });

  it("no live expiry, an unknown status or an unreadable payload proves nothing (R16)", () => {
    const unreadable = { verdict: "kept", reason: "renewal_unreadable" };
    expect(renewalRecheckVerdict({ status: "failed", liveExpiresAt: null, payload })).toEqual(
      unreadable,
    );
    expect(
      renewalRecheckVerdict({ status: "pending" as never, liveExpiresAt: at(BEFORE), payload }),
    ).toEqual(unreadable);
    expect(
      renewalRecheckVerdict({
        status: "failed",
        liveExpiresAt: at("invalid"),
        payload,
      }),
    ).toEqual(unreadable);
    for (const bad of [
      {},
      null,
      "x",
      { currentExpiryYear: 2031 },
      { currentExpiryYear: 2031, currentExpiresAt: "2031-03-04T05:06:07.89Z" },
      { currentExpiryYear: 2031, currentExpiresAt: "2031-03-04" },
      { currentExpiryYear: "2031", currentExpiresAt: BEFORE },
      { currentExpiryYear: 2031.5, currentExpiresAt: BEFORE },
      // The instant and the year of the payload disagree.
      { currentExpiryYear: 2030, currentExpiresAt: BEFORE },
    ]) {
      expect(
        renewalRecheckVerdict({ status: "failed", liveExpiresAt: at(BEFORE), payload: bad }),
        JSON.stringify(bad),
      ).toEqual(unreadable);
    }
  });
});

describe("renewalConfirmable", () => {
  it("only a renew_domain stuck in needs_attention at poll", () => {
    expect(
      renewalConfirmable({ kind: "renew_domain", state: "needs_attention", step: "poll" }),
    ).toBe(true);
    for (const target of [
      { kind: "renew_domain", state: "needs_attention", step: "submit" },
      { kind: "renew_domain", state: "needs_attention", step: null },
      { kind: "renew_domain", state: "waiting", step: "poll" },
      { kind: "renew_domain", state: "failed", step: "poll" },
      { kind: "create", state: "needs_attention", step: "poll" },
      { kind: "set_name_servers", state: "needs_attention", step: "poll" },
    ]) {
      expect(renewalConfirmable(target), JSON.stringify(target)).toBe(false);
    }
  });
});

describe("sameRenewalTarget", () => {
  const before = {
    kind: "renew_domain",
    state: "needs_attention",
    step: "poll",
    attempts: 3,
    lastError: "upstream_unavailable",
  };
  it("is true only when nothing the check relied on moved", () => {
    expect(sameRenewalTarget(before, { ...before })).toBe(true);
    expect(sameRenewalTarget(before, { ...before, attempts: 4 })).toBe(false);
    expect(sameRenewalTarget(before, { ...before, lastError: "conflict" })).toBe(false);
    expect(sameRenewalTarget(before, { ...before, state: "queued" })).toBe(false);
    expect(sameRenewalTarget(before, { ...before, step: "submit" })).toBe(false);
  });
});
