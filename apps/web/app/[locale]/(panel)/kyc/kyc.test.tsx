import { describe, expect, it } from "vitest";
import { checkFiles } from "./KycForm.tsx";
import { LIMITS, submission } from "./kyc.fixtures.ts";
import { kyc } from "./mockup-states.tsx";

describe("checkFiles (the browser's quick check; the server checks again)", () => {
  const ok = { type: "image/jpeg", size: 1000 };
  it("accepts one or two files inside the limits", () => {
    expect(checkFiles([ok], LIMITS)).toBeNull();
    expect(checkFiles([ok, { type: "application/pdf", size: LIMITS.maxBytes }], LIMITS)).toBeNull();
  });
  it("names the first problem", () => {
    expect(checkFiles([], LIMITS)).toBe("required");
    expect(checkFiles([ok, ok, ok], LIMITS)).toBe("required");
    expect(checkFiles([{ type: "image/gif", size: 5 }], LIMITS)).toBe("wrongType");
    expect(checkFiles([{ type: "", size: 5 }], LIMITS)).toBe("wrongType");
    expect(checkFiles([{ type: "image/png", size: LIMITS.maxBytes + 1 }], LIMITS)).toBe("tooBig");
    expect(checkFiles([{ type: "image/png", size: 0 }], LIMITS)).toBe("tooBig");
  });
});

describe("the /kyc states", () => {
  it("the form offers the document types of the account type, a file input and no document number value", () => {
    const html = kyc({ state: "form", customerType: null })("en");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/jpeg,image/png,application/pdf"');
    expect(html).toContain('value="nid"');
    expect(html).not.toContain('value="trade_license"');
    expect(html).toContain('name="documentNumber"');
    expect(html).toMatch(/autoComplete="off"|autocomplete="off"/);
  });

  it("the business form offers business documents", () => {
    const html = kyc({ state: "form", customerType: "business" })("en");
    // The first render takes the account type from the profile.
    expect(html).toContain('value="business"');
  });

  it("shows the reviewer's note as text, escaped, and offers a new submission only when it can", () => {
    const note = "<script>alert(1)</script>";
    const screen = {
      state: "rejected" as const,
      submission: submission("rejected", note),
      customerType: "individual" as const,
    };
    const open = kyc({ ...screen, canResubmit: true })("en");
    expect(open).not.toContain("<script>alert(1)");
    expect(open).toContain("&lt;script&gt;");
    expect(open).toContain('type="file"');
    const closed = kyc({ ...screen, canResubmit: false })("en");
    expect(closed).not.toContain('type="file"');
    expect(closed).toContain("alert-danger");
  });

  it("pending and verified show no form, in Bengali first", () => {
    for (const screen of [
      { state: "pending" as const, submission: submission("pending") },
      { state: "verified" as const },
    ]) {
      expect(kyc(screen)("bn")).not.toContain("<form");
      expect(kyc(screen)("bn")).toMatch(/[ঀ-৿]/);
    }
  });

  it("names no AWS account, key or ARN in any state", () => {
    for (const screen of [
      { state: "form" as const, customerType: null },
      { state: "unavailable" as const },
    ]) {
      expect(kyc(screen)("en")).not.toMatch(/arn:aws|\b\d{12}\b|kyc\//);
    }
  });
});
