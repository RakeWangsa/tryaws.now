import { beforeEach, describe, expect, it, vi } from "vitest";

// Review finding of 2026-11-13: the two audited GET routes must refuse a request that does not come
// from the admin app itself, before any dependency is built (no read, no audit row).
const deps = vi.hoisted(() => ({ audit: vi.fn(), kyc: vi.fn() }));
vi.mock("../../server/runtime.ts", () => ({
  auditExportDeps: deps.audit,
  kycDocumentDeps: deps.kyc,
}));

const ALLOWED = "203.0.113.5:44321";
const url = (path: string) => `https://admin.tryaws.now${path}`;

beforeEach(() => {
  deps.audit.mockReset();
  deps.kyc.mockReset();
  vi.stubEnv("ADMIN_IP_ALLOWLIST", "203.0.113.0/24");
  vi.stubEnv("APP_ORIGIN", "https://admin.tryaws.now");
  vi.stubEnv("TC_STAGE", "local");
});

describe("audit export route", () => {
  it("refuses a cross-site request before touching any dependency", async () => {
    const { GET } = await import("./audit-export/route.ts");
    const response = await GET(
      new Request(url("/api/audit-export?reason=x"), {
        headers: { "cloudfront-viewer-address": ALLOWED, "sec-fetch-site": "cross-site" },
      }),
    );
    expect(response.status).toBe(403);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("refuses a request with no origin evidence (fail closed)", async () => {
    const { GET } = await import("./audit-export/route.ts");
    const response = await GET(
      new Request(url("/api/audit-export?reason=x"), {
        headers: { "cloudfront-viewer-address": ALLOWED },
      }),
    );
    expect(response.status).toBe(403);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("an address outside the allowlist is refused first", async () => {
    const { GET } = await import("./audit-export/route.ts");
    const response = await GET(
      new Request(url("/api/audit-export"), {
        headers: { "cloudfront-viewer-address": "198.51.100.9:1", "sec-fetch-site": "same-origin" },
      }),
    );
    expect(response.status).toBe(403);
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe("KYC document route", () => {
  it("refuses a cross-site request before touching any dependency", async () => {
    const { GET } = await import("./kyc-document/[submissionId]/[index]/route.ts");
    const response = await GET(
      new Request(url("/api/kyc-document/abc/0?reason=x"), {
        headers: { "cloudfront-viewer-address": ALLOWED, "sec-fetch-site": "cross-site" },
      }),
      { params: Promise.resolve({ submissionId: "abc", index: "0" }) },
    );
    expect(response.status).toBe(403);
    expect(deps.kyc).not.toHaveBeenCalled();
  });

  it("refuses a request with no origin evidence (fail closed)", async () => {
    const { GET } = await import("./kyc-document/[submissionId]/[index]/route.ts");
    const response = await GET(
      new Request(url("/api/kyc-document/abc/0?reason=x"), {
        headers: { "cloudfront-viewer-address": ALLOWED },
      }),
      { params: Promise.resolve({ submissionId: "abc", index: "0" }) },
    );
    expect(response.status).toBe(403);
    expect(deps.kyc).not.toHaveBeenCalled();
  });
});
