import { describe, expect, it } from "vitest";
import {
  KYC_MAX_FILE_BYTES,
  canSubmitKyc,
  documentTypesFor,
  kycObjectKey,
  nextKycStatus,
  normalizeDocumentNumber,
  parseKycStart,
  parseKycSubmit,
  redactDocumentNumber,
} from "./rules";

const C = "0192f3a0-0000-7000-8000-000000000001";
const S = "0192f3a0-0000-7000-8000-000000000002";

describe("kyc status transitions", () => {
  it("moves none or rejected to pending, and pending to verified or rejected", () => {
    expect(nextKycStatus("none", "submit")).toBe("pending");
    expect(nextKycStatus("rejected", "submit")).toBe("pending");
    expect(nextKycStatus("pending", "approve")).toBe("verified");
    expect(nextKycStatus("pending", "reject")).toBe("rejected");
  });
  it("refuses every other pair", () => {
    expect(nextKycStatus("pending", "submit")).toBeNull();
    expect(nextKycStatus("verified", "submit")).toBeNull();
    expect(nextKycStatus("verified", "reject")).toBeNull();
    expect(nextKycStatus("none", "approve")).toBeNull();
    expect(nextKycStatus("rejected", "approve")).toBeNull();
    expect(nextKycStatus("bogus" as never, "submit")).toBeNull();
  });
  it("allows one open submission and none once verified", () => {
    expect(canSubmitKyc("none", false)).toBe(true);
    expect(canSubmitKyc("rejected", false)).toBe(true);
    expect(canSubmitKyc("none", true)).toBe(false);
    expect(canSubmitKyc("pending", false)).toBe(false);
    expect(canSubmitKyc("verified", false)).toBe(false);
  });
});

describe("parseKycStart", () => {
  const ok = {
    customerType: "individual",
    documentType: "nid",
    files: [{ contentType: "image/jpeg", size: 1000 }],
  };
  it("accepts a document of the customer type", () => {
    expect(parseKycStart(ok).ok).toBe(true);
    expect(documentTypesFor("business")).toContain("trade_license");
  });
  it("refuses a document of the other customer type", () => {
    const r = parseKycStart({ ...ok, documentType: "trade_license" });
    expect(r).toEqual({ ok: false, fields: { documentType: "invalid" } });
  });
  it("enforces size, type and count", () => {
    const big = { contentType: "image/png", size: KYC_MAX_FILE_BYTES + 1 };
    expect(parseKycStart({ ...ok, files: [big] }).ok).toBe(false);
    expect(parseKycStart({ ...ok, files: [{ contentType: "image/gif", size: 5 }] }).ok).toBe(false);
    expect(parseKycStart({ ...ok, files: [] }).ok).toBe(false);
    const f = { contentType: "application/pdf", size: 10 };
    expect(parseKycStart({ ...ok, files: [f, f, f] }).ok).toBe(false);
    expect(parseKycStart({ ...ok, files: [f, f] }).ok).toBe(true);
    expect(parseKycStart({ ...ok, files: [{ contentType: "image/png", size: 1.5 }] }).ok).toBe(
      false,
    );
    expect(parseKycStart(null).ok).toBe(false);
  });
});

describe("document numbers", () => {
  it("normalises and checks the shape per type", () => {
    expect(normalizeDocumentNumber("nid", "1234 567 890")).toBe("1234567890");
    expect(normalizeDocumentNumber("nid", "12345")).toBeNull();
    expect(normalizeDocumentNumber("passport", "ab1234567")).toBe("AB1234567");
    expect(normalizeDocumentNumber("passport", "ab-12")).toBeNull();
    expect(normalizeDocumentNumber("tin_certificate", "123456789012")).toBe("123456789012");
    expect(normalizeDocumentNumber("nid", 1234567890)).toBeNull();
    expect(normalizeDocumentNumber("nid", "1".repeat(100))).toBeNull();
  });
  it("parseKycSubmit returns the normalised number and never echoes a bad one in its fields", () => {
    const good = {
      submissionId: S,
      customerType: "individual",
      documentType: "nid",
      documentNumber: "1234567890",
      fileTypes: ["image/jpeg"],
    };
    const r = parseKycSubmit(good);
    expect(r.ok && r.value.documentNumber).toBe("1234567890");
    const bad = parseKycSubmit({ ...good, documentNumber: "999" });
    expect(bad).toEqual({ ok: false, fields: { documentNumber: "invalid" } });
    expect(JSON.stringify(bad)).not.toContain("999");
    expect(parseKycSubmit({ ...good, submissionId: "x" }).ok).toBe(false);
    expect(parseKycSubmit({ ...good, fileTypes: [] }).ok).toBe(false);
  });
  it("redacts", () => {
    expect(redactDocumentNumber()).toBe("[redacted]");
  });
});

describe("kycObjectKey", () => {
  it("is made of ids, a counter and a fixed extension", () => {
    expect(kycObjectKey(C, S, 1, "application/pdf")).toBe(`kyc/${C}/${S}/1.pdf`);
    expect(kycObjectKey(C, S, 0, "image/jpeg")).toBe(`kyc/${C}/${S}/0.jpg`);
  });
  it("refuses an id that is not a UUID (customer text never becomes a key, R11)", () => {
    expect(() => kycObjectKey("../x", S, 0, "image/png")).toThrow(TypeError);
    expect(() => kycObjectKey(C, `${S}/../..`, 0, "image/png")).toThrow(TypeError);
    expect(() => kycObjectKey(C, S, 2, "image/png")).toThrow(RangeError);
  });
});
