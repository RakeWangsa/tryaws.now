import type { KycSubmissionView } from "@tc/db";
import { describe, expect, it } from "vitest";
import { decideKycScreen } from "./kyc-view.ts";

const sub = (status: KycSubmissionView["status"]): KycSubmissionView => ({
  id: "0190aaaa-0000-7000-8000-000000000001",
  documentType: "nid",
  status,
  reviewedAt: null,
  note: status === "rejected" ? "unclear photo" : null,
  createdAt: new Date("2026-11-12T00:00:00Z"),
});
const base = { kycStatus: "none", customerType: null, latest: null, configured: true } as const;

describe("decideKycScreen", () => {
  it("offers the form to a customer who never submitted", () => {
    expect(decideKycScreen(base)).toEqual({ state: "form", customerType: null });
  });
  it("shows verified whatever the newest submission says", () => {
    expect(decideKycScreen({ ...base, kycStatus: "verified", latest: sub("pending") })).toEqual({
      state: "verified",
    });
  });
  it("shows pending with the submission, and no form", () => {
    expect(decideKycScreen({ ...base, latest: sub("pending") })).toMatchObject({
      state: "pending",
    });
  });
  it("shows the rejection with the note, and lets the customer submit again only when the ports are there", () => {
    expect(decideKycScreen({ ...base, latest: sub("rejected") })).toMatchObject({
      state: "rejected",
      canResubmit: true,
    });
    expect(decideKycScreen({ ...base, latest: sub("rejected"), configured: false })).toMatchObject({
      state: "rejected",
      canResubmit: false,
    });
  });
  it("is unavailable, not a form, when the upload port is not configured (R16)", () => {
    expect(decideKycScreen({ ...base, configured: false })).toEqual({ state: "unavailable" });
    expect(decideKycScreen({ ...base, configured: false, latest: sub("pending") })).toMatchObject({
      state: "pending",
    });
  });
});
