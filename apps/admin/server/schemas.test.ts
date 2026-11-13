import { describe, expect, it } from "vitest";
import {
  adminsAction,
  capacityEnvelope,
  capacityLimit,
  capacityWaitlist,
  check,
  createAdjustment,
  customerAction,
  cspReportBody,
  isBlueprintId,
  isMarket,
  isUuid,
  auditExportParams,
  kycDocumentParams,
  manualRefund,
  optionalText,
  planMarkAction,
  reason,
  reasonedId,
  signInForm,
  takaToMinor,
  uuid,
  wholeNumber,
} from "./schemas.ts";

// WPU-B6, item 28: the zod schemas of the admin app. A schema answers with the cleaned value or null.
const ID = "0191A000-0000-7000-8000-000000000001";
const id = ID.toLowerCase();

describe("primitives", () => {
  it("uuid is lower-cased, and anything else is refused", () => {
    expect(check(uuid, ID)).toBe(id);
    for (const bad of ["", "x", 7, null, undefined, `${ID} `, `${ID}0`, {}, [ID]]) {
      expect(check(uuid, bad)).toBeNull();
      expect(isUuid(bad)).toBe(false);
    }
  });

  it("market, blueprint id", () => {
    expect(isMarket("BD")).toBe(true);
    for (const bad of ["bd", "BDT", "B", "", 1, null]) expect(isMarket(bad)).toBe(false);
    expect(isBlueprintId("ubuntu_24_04")).toBe(true);
    for (const bad of ["Ubuntu", "a b", "", "x".repeat(65), undefined]) {
      expect(isBlueprintId(bad)).toBe(false);
    }
  });

  it("reason is trimmed, not empty, at most 500", () => {
    expect(check(reason, "  why  ")).toBe("why");
    for (const bad of ["", "   ", "x".repeat(501), 1, null, undefined]) {
      expect(check(reason, bad)).toBeNull();
    }
    expect(check(reason, "x".repeat(500))).toHaveLength(500);
  });

  it("optionalText: nothing for missing, null, empty and blank; refuses a longer raw value", () => {
    const note = optionalText(5);
    for (const nothing of [undefined, null, "", "   "])
      expect(check(note, nothing)).toBeUndefined();
    expect(check(note, " ab ")).toBe("ab");
    expect(check(note, "abcdef")).toBeNull();
    expect(check(note, 5)).toBeNull();
  });

  it("wholeNumber: digits only, in range, no float, no sign, no exponent", () => {
    const n = wholeNumber(1, 100);
    expect(check(n, "42")).toBe(42);
    expect(check(n, 42)).toBe(42);
    for (const bad of ["0", "101", "-1", "1.5", "1e2", "", " ", "abc", "0x10", null, 1.5, 1e21]) {
      expect(check(n, bad)).toBeNull();
    }
  });

  it("takaToMinor is integer arithmetic: paisa as bigint, above zero, two decimals at most", () => {
    expect(check(takaToMinor, "1")).toBe(100n);
    expect(check(takaToMinor, " 12.5 ")).toBe(1250n);
    expect(check(takaToMinor, "0.07")).toBe(7n);
    for (const bad of ["0", "0.00", "-1", "1.234", "1e3", "", "1,000", 5, null]) {
      expect(check(takaToMinor, bad)).toBeNull();
    }
  });
});

describe("customer decisions", () => {
  const base = { kind: "suspend", id: ID, reason: " r " };
  it("accepts every kind and cleans the text", () => {
    expect(check(customerAction, base)).toEqual({
      kind: "suspend",
      id: ID,
      reason: "r",
      note: undefined,
      tier: undefined,
    });
    expect(check(customerAction, { ...base, note: " n " })?.note).toBe("n");
  });
  it("setRiskTier needs a known tier, the other kinds ignore it", () => {
    expect(check(customerAction, { ...base, kind: "setRiskTier", tier: "trusted" })?.tier).toBe(
      "trusted",
    );
    expect(check(customerAction, { ...base, kind: "setRiskTier", tier: "vip" })).toBeNull();
    expect(check(customerAction, { ...base, kind: "setRiskTier" })).toBeNull();
    expect(check(customerAction, { ...base, tier: "vip" })?.tier).toBeUndefined();
  });
  it("refuses an unknown kind, a bad id, a missing reason, a long note", () => {
    expect(check(customerAction, { ...base, kind: "delete" })).toBeNull();
    expect(check(customerAction, { ...base, id: "1" })).toBeNull();
    expect(check(customerAction, { ...base, reason: "" })).toBeNull();
    expect(check(customerAction, { ...base, note: "x".repeat(501) })).toBeNull();
  });
});

describe("admin directory", () => {
  it("invite takes an e-mail and a role, and lower-cases the e-mail", () => {
    const out = check(adminsAction, {
      kind: "inviteAdmin",
      email: " New.Admin@Example.COM ",
      role: "ops",
      reason: "new hire",
    });
    expect(out).toEqual({
      kind: "inviteAdmin",
      reason: "new hire",
      id: null,
      email: "new.admin@example.com",
      role: "ops",
    });
  });
  it("the other kinds take an id; setAdminRole also a role", () => {
    expect(check(adminsAction, { kind: "disableAdmin", id: ID, reason: "x" })?.id).toBe(id);
    expect(
      check(adminsAction, { kind: "setAdminRole", id: ID, role: "root", reason: "x" }),
    ).toBeNull();
    expect(
      check(adminsAction, { kind: "setAdminRole", id: ID, role: "finance", reason: "x" })?.role,
    ).toBe("finance");
    expect(check(adminsAction, { kind: "enableAdmin", id: "nope", reason: "x" })).toBeNull();
  });
  it("refuses a bad e-mail", () => {
    for (const email of ["a", "a@b", "a b@c.de", `${"x".repeat(65)}@c.de`, 5, undefined]) {
      expect(
        check(adminsAction, { kind: "inviteAdmin", email, role: "ops", reason: "x" }),
      ).toBeNull();
    }
  });
});

describe("operations, plan mark, reasoned ids", () => {
  it("reasonedId lower-cases the id", () => {
    expect(check(reasonedId, { id: ID, reason: "x" })).toEqual({ id, reason: "x" });
    expect(check(reasonedId, { id: ID })).toBeNull();
  });
  it("planMarkAction needs both ids", () => {
    expect(check(planMarkAction, { resourceId: ID, requestId: ID, reason: "x" })).toEqual({
      resourceId: id,
      requestId: id,
      reason: "x",
    });
    expect(check(planMarkAction, { resourceId: ID, requestId: "no", reason: "x" })).toBeNull();
  });
});

describe("money", () => {
  const adjustment = {
    customerId: ID,
    direction: "credit",
    adjustmentKind: "goodwill",
    amount: "10.50",
  };
  it("createAdjustment returns paisa as a bigint and an optional evidence", () => {
    const out = check(createAdjustment, { ...adjustment, evidence: " ticket 7 " });
    expect(out).toMatchObject({ customerId: id, amount: 1050n, evidence: "ticket 7" });
    expect(check(createAdjustment, adjustment)?.evidence).toBeUndefined();
  });
  it("refuses a bad direction, kind, amount or evidence", () => {
    expect(check(createAdjustment, { ...adjustment, direction: "sideways" })).toBeNull();
    expect(check(createAdjustment, { ...adjustment, adjustmentKind: "gift" })).toBeNull();
    expect(check(createAdjustment, { ...adjustment, amount: "0" })).toBeNull();
    expect(check(createAdjustment, { ...adjustment, evidence: "x".repeat(201) })).toBeNull();
  });
  it("manualRefund needs an amount", () => {
    expect(check(manualRefund, { amount: "5" })?.amount).toBe(500n);
    expect(check(manualRefund, {})).toBeNull();
  });
});

describe("capacity", () => {
  it("the envelope needs a kind, a reason and a region", () => {
    const ok = { kind: "setCapacityLimit", reason: "x", region: "ap-southeast-1" };
    expect(check(capacityEnvelope, ok)).toEqual(ok);
    expect(check(capacityEnvelope, { ...ok, region: "mars" })).toBeNull();
    expect(check(capacityEnvelope, { ...ok, region: "global" })?.region).toBe("global");
    expect(check(capacityEnvelope, { ...ok, kind: "other" })).toBeNull();
  });
  it("a limit is a pool id, a known quota code and a whole number", () => {
    const schema = capacityLimit(["instances", "databases"]);
    expect(check(schema, { poolAccountId: ID, quotaCode: "instances", limit: "10" })).toEqual({
      poolAccountId: id,
      quotaCode: "instances",
      limit: 10,
    });
    expect(check(schema, { poolAccountId: ID, quotaCode: "x", limit: "10" })).toBeNull();
    expect(check(schema, { poolAccountId: ID, quotaCode: "instances", limit: "-1" })).toBeNull();
  });
  it("a waitlist notice is a family, a reason and a count from 1 to 100", () => {
    const ok = { productFamily: "database", waitlistReason: "capacity", count: "5" };
    expect(check(capacityWaitlist, ok)?.count).toBe(5);
    expect(check(capacityWaitlist, { ...ok, count: "101" })).toBeNull();
    expect(check(capacityWaitlist, { ...ok, waitlistReason: "mood" })).toBeNull();
    expect(check(capacityWaitlist, { ...ok, productFamily: "Data base" })).toBeNull();
  });
});

describe("routes and sign-in", () => {
  it("the KYC document route takes a UUID, an index of one or two digits and a reason (R10)", () => {
    const reason = "id check for case 12";
    expect(check(kycDocumentParams, { submissionId: ID, index: "3", reason })).toEqual({
      submissionId: ID,
      index: 3,
      reason,
    });
    for (const index of ["", "100", "-1", "1.5", "a", undefined]) {
      expect(check(kycDocumentParams, { submissionId: ID, index, reason })).toBeNull();
    }
    expect(check(kycDocumentParams, { submissionId: "x", index: "1", reason })).toBeNull();
    // no reason, a blank one, a list and an over-long one are refused; the reason is trimmed
    for (const bad of [undefined, "", "   ", ["a", "b"], "x".repeat(501)]) {
      expect(check(kycDocumentParams, { submissionId: ID, index: "1", reason: bad })).toBeNull();
    }
    expect(
      check(kycDocumentParams, { submissionId: ID, index: "1", reason: "  look  " }),
    ).toMatchObject({ reason: "look" });
  });
  it("the audit export takes a reason, trimmed, and nothing else is required (R10)", () => {
    expect(check(auditExportParams, { reason: "  quarterly review " })).toEqual({
      reason: "quarterly review",
    });
    for (const bad of [undefined, "", "   ", ["a"], "x".repeat(501)]) {
      expect(check(auditExportParams, { reason: bad })).toBeNull();
    }
  });
  it("a CSP report is an object or a list; a scalar is refused", () => {
    expect(check(cspReportBody, { "csp-report": {} })).toEqual({ "csp-report": {} });
    expect(check(cspReportBody, [{ type: "csp-violation" }])).toHaveLength(1);
    for (const bad of [null, 5, "x", undefined]) expect(check(cspReportBody, bad)).toBeNull();
  });
  it("sign-in fields are strings of bounded length", () => {
    expect(check(signInForm, { email: "a@b.c", password: "p", code: "123456" })).not.toBeNull();
    expect(check(signInForm, { email: "a", password: "p".repeat(1025), code: "1" })).toBeNull();
    expect(check(signInForm, { email: 1, password: "p", code: "1" })).toBeNull();
  });
});
