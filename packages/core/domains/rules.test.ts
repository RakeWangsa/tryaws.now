import { describe, expect, it } from "vitest";
import { decideDestructive } from "../lifecycle/guard";
import { checkSecondConfirmation } from "./confirm";
import { parseRegistrantContact, redactContact, type RegistrantContact } from "./contact";
import { DOMAIN_STATES, canMoveDomain, nextDomainState } from "./state";
import { decideTld, tldPolicyOf, type TldRow } from "./tld";
import {
  RENEWAL_REMINDER_DAYS,
  RENEW_LEAD_DAYS,
  domainRenewalAction,
  domainRenewalUsd,
  renewLeadDaysOf,
  type RenewalFacts,
} from "./renewal";

const DAY = 24 * 60 * 60 * 1000;

describe("decideTld", () => {
  const base: TldRow = {
    tld: "com",
    registrationPriceUsd: "13.0000",
    renewalPriceUsd: "15.0000",
    needsExtraParams: false,
  };
  it("registers a plain TLD with a price by itself", () => {
    expect(decideTld(base)).toBe("auto");
  });
  it("sends a TLD with extra parameters to admin review (spec 12)", () => {
    expect(decideTld({ ...base, tld: "ai", needsExtraParams: true })).toBe("review");
  });
  it("offers nothing without a registration or a renewal price (fail closed)", () => {
    expect(decideTld({ ...base, registrationPriceUsd: null })).toBe("unavailable");
    expect(decideTld({ ...base, renewalPriceUsd: null })).toBe("unavailable");
    expect(decideTld({ ...base, registrationPriceUsd: "not a number" })).toBe("unavailable");
    expect(decideTld({ ...base, registrationPriceUsd: "-1" })).toBe("unavailable");
  });
  it("tldPolicyOf lists every row with its decision", () => {
    expect(tldPolicyOf([base, { ...base, tld: "ai", needsExtraParams: true }])).toEqual([
      { tld: "com", decision: "auto" },
      { tld: "ai", decision: "review" },
    ]);
  });
});

describe("checkSecondConfirmation", () => {
  it("passes only when the typed name repeats the name exactly", () => {
    expect(checkSecondConfirmation("example.com", "example.com").ok).toBe(true);
    expect(checkSecondConfirmation("example.com", "  example.com  ").ok).toBe(true);
  });
  it("refuses a different name, another case, a missing name and non-text", () => {
    for (const typed of ["example.net", "Example.com", "example.com.", "", undefined, 5, null]) {
      const r = checkSecondConfirmation("example.com", typed);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fields).toEqual({ confirmName: "mismatch" });
    }
  });
  it("never passes for an empty name", () => {
    expect(checkSecondConfirmation("", "").ok).toBe(false);
  });
});

const GOOD = {
  contactType: "PERSON",
  firstName: "Rahim",
  lastName: "Uddin",
  email: "rahim@example.com",
  phoneNumber: "+880.1712345678",
  addressLine1: "House 1, Road 2",
  city: "Dhaka",
  state: "Dhaka",
  countryCode: "BD",
  zipCode: "1212",
};

describe("parseRegistrantContact", () => {
  it("accepts the WHOIS fields and drops unknown keys", () => {
    const r = parseRegistrantContact({ ...GOOD, extra: "x", awsName: "tc-x" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value).sort()).toEqual(
        [
          "addressLine1",
          "city",
          "contactType",
          "countryCode",
          "email",
          "firstName",
          "lastName",
          "phoneNumber",
          "state",
          "zipCode",
        ].sort(),
      );
    }
  });
  it("needs an organization name for a company", () => {
    const company = parseRegistrantContact({ ...GOOD, contactType: "COMPANY" });
    expect(company.ok).toBe(false);
    if (!company.ok) expect(company.fields).toEqual({ organizationName: "required" });
    expect(
      parseRegistrantContact({ ...GOOD, contactType: "COMPANY", organizationName: "ACME Ltd" }).ok,
    ).toBe(true);
  });
  it("collects every invalid field and repeats no value", () => {
    const r = parseRegistrantContact({
      ...GOOD,
      firstName: "",
      email: "nope",
      phoneNumber: "01712345678",
      countryCode: "bangladesh",
      zipCode: "x".repeat(300),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fields).toEqual({
        firstName: "invalid",
        email: "invalid",
        phoneNumber: "invalid",
        countryCode: "invalid",
        zipCode: "invalid",
      });
      expect(JSON.stringify(r)).not.toContain("nope");
    }
  });
  it("refuses control characters and markup in any text field", () => {
    expect(parseRegistrantContact({ ...GOOD, city: "Dha\u0000ka" }).ok).toBe(false);
    expect(parseRegistrantContact({ ...GOOD, addressLine1: "<script>" }).ok).toBe(false);
  });
  it("refuses non-objects", () => {
    expect(parseRegistrantContact(null).ok).toBe(false);
    expect(parseRegistrantContact("x").ok).toBe(false);
  });
});

describe("redactContact (R14)", () => {
  it("keeps the country and the type, and no name, number or address", () => {
    const parsed = parseRegistrantContact(GOOD);
    if (!parsed.ok) throw new Error("fixture");
    const view = redactContact(parsed.value as RegistrantContact);
    expect(view).toEqual({ contactType: "PERSON", countryCode: "BD", emailDomain: "example.com" });
    const text = JSON.stringify(view);
    for (const secret of ["Rahim", "Uddin", "1712345678", "House 1", "rahim@"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("domain state machine", () => {
  it("has the five states of 16.10 and the admin review step", () => {
    expect([...DOMAIN_STATES].sort()).toEqual(
      ["awaiting_verification", "expired", "failed", "pending", "registered", "review"].sort(),
    );
  });
  it("walks the happy path", () => {
    expect(nextDomainState("pending", "registration_succeeded")).toBe("awaiting_verification");
    expect(nextDomainState("awaiting_verification", "contact_verified")).toBe("registered");
    expect(nextDomainState("registered", "expiry_passed")).toBe("expired");
  });
  it("sends an extra-parameter TLD through review before registering", () => {
    expect(nextDomainState("review", "approved")).toBe("pending");
    expect(nextDomainState("review", "rejected")).toBe("failed");
    expect(canMoveDomain("review", "registered")).toBe(false);
  });
  it("fails a pending registration and lets an expired name be renewed back", () => {
    expect(nextDomainState("pending", "registration_failed")).toBe("failed");
    expect(nextDomainState("expired", "renewed")).toBe("registered");
    expect(nextDomainState("registered", "renewed")).toBe("registered");
    expect(nextDomainState("awaiting_verification", "renewed")).toBe("awaiting_verification");
  });
  it("refuses a move it does not know (null, never a guess)", () => {
    expect(nextDomainState("failed", "contact_verified")).toBeNull();
    expect(nextDomainState("pending", "contact_verified")).toBeNull();
    expect(nextDomainState("bogus", "approved")).toBeNull();
    expect(nextDomainState("registered", "nonsense")).toBeNull();
  });
  it("has no event that deletes a domain", () => {
    for (const from of DOMAIN_STATES) {
      expect(nextDomainState(from, "delete")).toBeNull();
      expect(nextDomainState(from, "destroy")).toBeNull();
    }
  });
});

describe("domainRenewalAction", () => {
  const expiresAt = new Date("2027-11-12T00:00:00Z");
  const facts = (daysLeft: number, extra: Partial<RenewalFacts> = {}): RenewalFacts => ({
    expiresAt,
    now: new Date(expiresAt.getTime() - daysLeft * DAY),
    autoRenew: false,
    remindersSent: [],
    ...extra,
  });
  it("reminds at 60, 30 and 7 days and never twice", () => {
    expect([...RENEWAL_REMINDER_DAYS]).toEqual([60, 30, 7]);
    expect(domainRenewalAction(facts(90))).toEqual({ kind: "none" });
    expect(domainRenewalAction(facts(60))).toEqual({ kind: "remind", days: 60 });
    expect(domainRenewalAction(facts(45))).toEqual({ kind: "remind", days: 60 });
    expect(domainRenewalAction(facts(45, { remindersSent: [60] }))).toEqual({ kind: "none" });
    expect(domainRenewalAction(facts(5, { remindersSent: [60, 30] }))).toEqual({
      kind: "remind",
      days: 7,
    });
  });
  it("renews only when auto-renew is on and the lead time is reached", () => {
    // WPU-Y2 (owner, 2026-11-14): RenewDomain at least 30 days before the registry expiry.
    expect(RENEW_LEAD_DAYS).toBe(30);
    expect(domainRenewalAction(facts(31, { autoRenew: true, remindersSent: [60] }))).toEqual({
      kind: "none",
    });
    expect(domainRenewalAction(facts(30, { autoRenew: true, remindersSent: [60] }))).toEqual({
      kind: "renew",
    });
    expect(domainRenewalAction(facts(20, { autoRenew: false, remindersSent: [60, 30] }))).toEqual({
      kind: "none",
    });
  });
  it("does nothing for a name that has already expired", () => {
    expect(domainRenewalAction(facts(-1, { autoRenew: true }))).toEqual({ kind: "expired" });
  });
});

describe("WPU-Y2: the lead time of a renewal charge", () => {
  it("is 30 days for a domain and none for every other family", () => {
    expect(renewLeadDaysOf("domain")).toBe(30);
    for (const family of ["linux_instance", "windows_instance", "dns_zone", "bucket", "cdn", ""]) {
      expect(renewLeadDaysOf(family), family).toBe(0);
    }
  });
});

describe("WPU-Y2: the USD price of a domain renewal", () => {
  const TLD_ID = "0190a000-0000-7000-8000-0000000000aa";
  const config = { productId: TLD_ID, tld: "com" };
  const tld = {
    id: TLD_ID,
    tld: "com",
    registrationPriceUsd: "13.0000",
    renewalPriceUsd: "15.5000",
    needsExtraParams: false,
  };
  const refused = { ok: false, error: "internal", fields: { renewalPrice: "unavailable" } };

  it("is the renewal price of the TLD row, not the registration price (owner rule a)", () => {
    expect(domainRenewalUsd(config, tld)).toEqual({ ok: true, value: "15.5000" });
    // a TLD whose renewal costs more than the registration renews at the renewal price
    expect(
      domainRenewalUsd(config, {
        ...tld,
        registrationPriceUsd: "5.0000",
        renewalPriceUsd: "48.0000",
      }),
    ).toEqual({ ok: true, value: "48.0000" });
  });

  it("still renews a TLD that is no longer sold for registration, while it has a renewal price", () => {
    expect(domainRenewalUsd(config, { ...tld, registrationPriceUsd: null })).toEqual({
      ok: true,
      value: "15.5000",
    });
  });

  it("refuses without a readable positive renewal price, or a row that is not the domain's TLD (R16)", () => {
    for (const renewalPriceUsd of [null, "", "0", "0.0000", "-1", "1e3", "15.00001", " 15"]) {
      expect(
        domainRenewalUsd(config, { ...tld, renewalPriceUsd }),
        String(renewalPriceUsd),
      ).toEqual(refused);
    }
    expect(domainRenewalUsd(config, null)).toEqual(refused);
    expect(
      domainRenewalUsd(config, { ...tld, id: "0190a000-0000-7000-8000-0000000000bb" }),
    ).toEqual(refused);
    expect(domainRenewalUsd(config, { ...tld, tld: "net" })).toEqual(refused);
    for (const bad of [{}, { productId: TLD_ID }, { tld: "com" }, { productId: 7, tld: "com" }]) {
      expect(domainRenewalUsd(bad, tld), JSON.stringify(bad)).toEqual(refused);
    }
  });
});

describe("a domain is never destroyed by us (R13)", () => {
  it("the destructive guard refuses every destroy of the family domain", () => {
    for (const subscriptionStatus of ["active", "grace", "retained", "ended", null] as const) {
      for (const hasFinalSnapshot of [true, false]) {
        expect(
          decideDestructive("destroy", {
            subscriptionStatus,
            family: "domain",
            hasFinalSnapshot,
            isFinalBackup: false,
          }),
        ).toBe(false);
      }
    }
  });
});
