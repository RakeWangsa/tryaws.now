import type { CustomerSession } from "@tc/auth";
import type { AuditRepo, KycRepo, RateLimitsRepo } from "@tc/db";
import { describe, expect, it } from "vitest";
import { FakeKycCrypto, FakeKycObjectStore } from "./fakes/kyc-fakes.ts";
import {
  startKycUploadCore,
  submitKycCore,
  type KycActionDeps,
  type KycRepos,
} from "./kyc-actions.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "0190aaaa-0000-7000-8000-000000000001";
const NUMBER = "1234567890";

const session = (kycStatus: CustomerSession["kycStatus"] = "none"): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus,
  riskTier: "new",
  locale: "bn",
  signedInAt: NOW,
});

function world(
  over: {
    status?: CustomerSession["kycStatus"];
    limited?: boolean;
    submit?: "created" | "replayed" | "conflict";
  } = {},
) {
  const calls: string[] = [];
  const logged: unknown[] = [];
  const objects = new FakeKycObjectStore();
  const crypto = new FakeKycCrypto();
  const repos: KycRepos = {
    kyc: {
      latest: async () => null,
      setType: async (type) => {
        calls.push(`setType:${type}`);
        return { ok: true, replayed: false, value: { type } };
      },
      submit: async (input) => {
        calls.push("submit");
        logged.push(input);
        if (over.submit === "conflict") return { ok: false, error: "conflict" };
        return {
          ok: true,
          replayed: over.submit === "replayed",
          value: {
            id: input.id,
            documentType: input.documentType,
            status: "pending",
            reviewedAt: null,
            note: null,
            createdAt: NOW,
          },
        };
      },
    } satisfies KycRepo,
    audit: {
      record: async (input) => {
        calls.push(`audit:${input.action}`);
        logged.push(input);
        return { ok: true, replayed: false, value: { id: "a" } };
      },
    } satisfies AuditRepo,
    rateLimits: {
      consume: async () => {
        calls.push("rateLimit");
        return over.limited === true
          ? { allowed: false, action: "kyc.write", retryAfterSeconds: 9 }
          : { allowed: true };
      },
    } satisfies RateLimitsRepo,
  };
  let current: CustomerSession | null = session(over.status);
  const deps: KycActionDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return current;
    },
    now: () => NOW,
    newId: () => SUBMISSION,
    store: async (customerId, fn) => {
      expect(customerId).toBe(CUSTOMER);
      return fn(repos);
    },
    ports: { objects, crypto },
  };
  return {
    deps,
    calls,
    logged,
    objects,
    setSession: (s: CustomerSession | null) => {
      current = s;
    },
  };
}

const START = {
  customerType: "individual",
  documentType: "nid",
  files: [{ contentType: "image/jpeg", size: 2048 }],
};
const SUBMIT = {
  submissionId: SUBMISSION,
  customerType: "individual",
  documentType: "nid",
  documentNumber: NUMBER,
  fileTypes: ["image/jpeg"],
};
const KEY0 = `kyc/${CUSTOMER}/${SUBMISSION}/0.jpg`;

describe("startKycUploadCore", () => {
  it("authenticates, validates, rate limits, audits and presigns, in that order", async () => {
    const w = world();
    const result = await startKycUploadCore(w.deps, START);
    expect(result).toMatchObject({ ok: true, submissionId: SUBMISSION });
    expect(w.calls).toEqual(["authenticate", "rateLimit", "audit:kyc.upload_started"]);
    expect(w.objects.presigned).toEqual([
      { key: KEY0, contentType: "image/jpeg", maxBytes: 5 * 1024 * 1024, expiresSeconds: 600 },
    ]);
  });

  it("refuses without a session, before anything else", async () => {
    const w = world();
    w.setSession(null);
    expect(await startKycUploadCore(w.deps, START)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(w.calls).toEqual(["authenticate"]);
  });

  it("refuses a verified customer and one with a pending check", async () => {
    expect(await startKycUploadCore(world({ status: "verified" }).deps, START)).toEqual({
      ok: false,
      error: "kyc_verified",
    });
    expect(await startKycUploadCore(world({ status: "pending" }).deps, START)).toEqual({
      ok: false,
      error: "kyc_pending",
    });
  });

  it("refuses a file that is too big, of the wrong type, or too many, with no database call", async () => {
    for (const files of [
      [{ contentType: "image/jpeg", size: 6 * 1024 * 1024 }],
      [{ contentType: "text/html", size: 10 }],
      [],
      [START.files[0], START.files[0], START.files[0]],
    ]) {
      const w = world();
      const result = await startKycUploadCore(w.deps, { ...START, files });
      expect(result).toEqual({ ok: false, error: "validation", fields: { files: "invalid" } });
      expect(w.calls).toEqual(["authenticate"]);
    }
  });

  it("answers rate_limited and presigns nothing", async () => {
    const w = world({ limited: true });
    expect(await startKycUploadCore(w.deps, START)).toEqual({ ok: false, error: "rate_limited" });
    expect(w.objects.presigned).toEqual([]);
  });

  it("is unavailable when the ports are not configured (R16)", async () => {
    const w = world();
    expect(await startKycUploadCore({ ...w.deps, ports: null }, START)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("submitKycCore", () => {
  it("checks the upload, seals the number, stores and audits, in that order", async () => {
    const w = world();
    w.objects.simulateUpload(KEY0, 2048, "image/jpeg");
    const result = await submitKycCore(w.deps, SUBMIT);
    expect(result).toEqual({ ok: true, status: "pending", replayed: false });
    expect(w.calls).toEqual([
      "authenticate",
      "rateLimit",
      "setType:individual",
      "submit",
      "audit:kyc.submitted",
    ]);
  });

  it("stores the sealed number and server-made keys; the plain number is in no stored value, audit or result", async () => {
    const w = world();
    w.objects.simulateUpload(KEY0, 2048, "image/jpeg");
    const result = await submitKycCore(w.deps, SUBMIT);
    expect(JSON.stringify(result)).not.toContain(NUMBER);
    const stored = w.logged[0] as { s3Keys: string[]; documentNumberEncrypted: Uint8Array };
    expect(stored.s3Keys).toEqual([KEY0]);
    expect(new TextDecoder().decode(stored.documentNumberEncrypted)).not.toContain(NUMBER);
    const audit = JSON.stringify(w.logged[1]);
    expect(audit).not.toContain(NUMBER);
    expect(audit).toContain("nid");
  });

  it("refuses a submission whose file never arrived, or arrived in another type or too big", async () => {
    const missing = world();
    expect(await submitKycCore(missing.deps, SUBMIT)).toEqual({
      ok: false,
      error: "upload_missing",
      fields: { files: "invalid" },
    });
    expect(missing.calls).not.toContain("submit");

    const wrongType = world();
    wrongType.objects.simulateUpload(KEY0, 10, "text/html");
    expect((await submitKycCore(wrongType.deps, SUBMIT)).ok).toBe(false);

    const tooBig = world();
    tooBig.objects.simulateUpload(KEY0, 6 * 1024 * 1024, "image/jpeg");
    expect((await submitKycCore(tooBig.deps, SUBMIT)).ok).toBe(false);
  });

  it("never takes an object key from the request", async () => {
    const w = world();
    w.objects.simulateUpload("kyc/other/other/0.jpg", 10, "image/jpeg");
    const result = await submitKycCore(w.deps, { ...SUBMIT, s3Keys: ["kyc/other/other/0.jpg"] });
    expect(result).toMatchObject({ ok: false, error: "upload_missing" });
  });

  it("refuses an invalid number without echoing it", async () => {
    const w = world();
    const result = await submitKycCore(w.deps, { ...SUBMIT, documentNumber: "12" });
    expect(result).toEqual({
      ok: false,
      error: "validation",
      fields: { documentNumber: "invalid" },
    });
    expect(JSON.stringify(result)).not.toContain('"12"');
    expect(w.calls).toEqual(["authenticate"]);
  });

  it("maps a second open submission to conflict, and a replay to a success with no second audit", async () => {
    const conflict = world({ submit: "conflict" });
    conflict.objects.simulateUpload(KEY0, 1, "image/jpeg");
    expect(await submitKycCore(conflict.deps, SUBMIT)).toEqual({ ok: false, error: "conflict" });

    const replay = world({ submit: "replayed" });
    replay.objects.simulateUpload(KEY0, 1, "image/jpeg");
    expect(await submitKycCore(replay.deps, SUBMIT)).toEqual({
      ok: true,
      status: "pending",
      replayed: true,
    });
    expect(replay.calls).not.toContain("audit:kyc.submitted");
  });

  it("answers rate_limited before it reads the object store", async () => {
    const w = world({ limited: true });
    expect(await submitKycCore(w.deps, SUBMIT)).toEqual({ ok: false, error: "rate_limited" });
  });

  it("refuses a verified customer, and unauthenticated", async () => {
    expect(await submitKycCore(world({ status: "verified" }).deps, SUBMIT)).toEqual({
      ok: false,
      error: "kyc_verified",
    });
    const w = world();
    w.setSession(null);
    expect(await submitKycCore(w.deps, SUBMIT)).toEqual({ ok: false, error: "unauthenticated" });
  });
});

describe("the object store port", () => {
  it("has no method that reads content", () => {
    const store = new FakeKycObjectStore();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).sort()).toEqual([
      "constructor",
      "head",
      "presignUpload",
      "simulateUpload",
    ]);
  });
});
