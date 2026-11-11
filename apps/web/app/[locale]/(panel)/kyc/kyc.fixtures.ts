import type { KycSubmissionView } from "@tc/db";
import type { KycLimits } from "./KycForm.tsx";

// Fixtures for the tests of /kyc: the limits as the page builds them, and a submission.

export const LIMITS: KycLimits = {
  maxBytes: 5 * 1024 * 1024,
  contentTypes: ["image/jpeg", "image/png", "application/pdf"],
  maxFiles: 2,
  documents: {
    individual: ["nid", "passport", "driving_license"],
    business: ["trade_license", "tin_certificate"],
  },
};

export const submission = (
  status: KycSubmissionView["status"],
  note: string | null = null,
): KycSubmissionView => ({
  id: "0190aaaa-0000-7000-8000-000000000001",
  documentType: "nid",
  status,
  reviewedAt: status === "pending" ? null : new Date("2026-11-12T08:00:00Z"),
  note,
  createdAt: new Date("2026-11-11T08:00:00Z"),
});
