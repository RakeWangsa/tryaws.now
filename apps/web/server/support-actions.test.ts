import type { CustomerSession } from "@tc/auth";
import { describe, expect, it } from "vitest";
import {
  createSupportRequestCore,
  type SupportActionDeps,
  type SupportRepos,
} from "./support-actions.ts";
import { parseSupportRequest } from "./support-request.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const ID = "0190aaaa-0000-7000-8000-000000000001";
const session: CustomerSession = {
  customerId: "11111111-1111-4111-8111-111111111111",
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: NOW,
};
const good = {
  category: "billing",
  subject: "Top-up not shown",
  message: "My payment went through but the wallet did not change.",
  idempotencyKey: "form-0123456789",
};

function world(
  over: { signedIn?: boolean; allowed?: boolean; replayed?: boolean; fail?: boolean } = {},
) {
  const calls: string[] = [];
  let storeCustomer = "";
  const repos = {
    support: {
      create: async (input: { subject: string }) => {
        calls.push(`create:${input.subject}`);
        if (over.fail) return { ok: false as const, error: "boom" };
        return { ok: true as const, id: ID, replayed: over.replayed === true };
      },
    },
    audit: {
      record: async (i: { action: string }) => {
        calls.push(`audit:${i.action}`);
        return { ok: true as const, replayed: false, value: { id: "a" } };
      },
    },
    rateLimits: {
      consume: async () => {
        calls.push("limit");
        return { allowed: over.allowed !== false } as never;
      },
    },
  } as unknown as SupportRepos;
  const deps: SupportActionDeps = {
    authenticate: async () => {
      calls.push("auth");
      return over.signedIn === false ? null : session;
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      storeCustomer = customerId;
      return fn(repos);
    },
  };
  return { deps, calls, customer: () => storeCustomer };
}

describe("createSupportRequestCore", () => {
  it("authenticates, validates, rate limits, writes and audits, in that order (R9)", async () => {
    const w = world();
    const r = await createSupportRequestCore(w.deps, good);
    expect(r).toEqual({ ok: true, id: ID, replayed: false });
    expect(w.calls).toEqual(["auth", "limit", "create:Top-up not shown", "audit:support.create"]);
  });

  it("takes the customer from the session, never from the input (R8)", async () => {
    const w = world();
    await createSupportRequestCore(w.deps, { ...good, customerId: "someone-else" });
    expect(w.customer()).toBe(session.customerId);
  });

  it("refuses without a session before anything else", async () => {
    const w = world({ signedIn: false });
    expect(await createSupportRequestCore(w.deps, good)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(w.calls).toEqual(["auth"]);
  });

  it("refuses an invalid form before the limit and the write", async () => {
    const w = world();
    const r = await createSupportRequestCore(w.deps, { ...good, category: "nope", subject: "" });
    expect(r).toMatchObject({
      ok: false,
      error: "validation",
      fields: { category: "invalid", subject: "invalid" },
    });
    expect(w.calls).toEqual(["auth"]);
  });

  it("writes nothing when the limit is used up", async () => {
    const w = world({ allowed: false });
    expect(await createSupportRequestCore(w.deps, good)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(w.calls).toEqual(["auth", "limit"]);
  });

  it("a replay audits nothing (R7)", async () => {
    const w = world({ replayed: true });
    expect(await createSupportRequestCore(w.deps, good)).toEqual({
      ok: true,
      id: ID,
      replayed: true,
    });
    expect(w.calls).not.toContain("audit:support.create");
  });

  it("fails closed when the write is refused (R16)", async () => {
    const w = world({ fail: true });
    expect(await createSupportRequestCore(w.deps, good)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("single-line and message text rules", () => {
  const chr = (code: number) => String.fromCharCode(code);
  const BREAKERS: Array<[string, string]> = [
    ["bare CR", chr(0x0d)],
    ["LF", chr(0x0a)],
    ["CRLF", chr(0x0d) + chr(0x0a)],
    ["TAB", chr(0x09)],
    ["VT", chr(0x0b)],
    ["FF", chr(0x0c)],
    ["NEL", chr(0x85)],
    ["LS", chr(0x2028)],
    ["PS", chr(0x2029)],
    ["NUL", chr(0)],
    ["DEL", chr(0x7f)],
    ["zero-width joiner", chr(0x200d)],
    ["zero-width space", chr(0x200b)],
    ["right-to-left override", chr(0x202e)],
  ];

  it.each(BREAKERS)("refuses %s in the subject, in the middle and at the end", (_n, c) => {
    expect(parseSupportRequest({ ...good, subject: `a${c}b` })).toMatchObject({
      ok: false,
      fields: { subject: "invalid" },
    });
    expect(parseSupportRequest({ ...good, subject: `abc${c}x` })).toMatchObject({ ok: false });
  });

  it("an injected header never reaches the writer: the stored subject has none of them", async () => {
    for (const [, c] of BREAKERS) {
      const w = world();
      const r = await createSupportRequestCore(w.deps, { ...good, subject: `Hi${c}Bcc: x@y.z` });
      expect(r).toMatchObject({ ok: false, error: "validation" });
      expect(w.calls.some((x) => x.startsWith("create:"))).toBe(false);
    }
    const ok = parseSupportRequest({ ...good, subject: "  caf" + chr(0x65) + chr(0x301) + "  " });
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) {
      expect(ok.value.subject).toBe("caf" + chr(0xe9)); // NFC, trimmed
      expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ok.value.subject)).toBe(false);
    }
  });

  it("counts the length after NFC", () => {
    const decomposed = ("e" + chr(0x301)).repeat(120); // 240 code units, 120 after NFC
    expect(parseSupportRequest({ ...good, subject: decomposed })).toMatchObject({ ok: true });
    expect(parseSupportRequest({ ...good, subject: "a".repeat(121) })).toMatchObject({ ok: false });
  });

  it("the message keeps LF and TAB but refuses CR, NEL, LS, PS, VT, FF and NUL", () => {
    expect(parseSupportRequest({ ...good, message: "line 1\n\tline 2" })).toMatchObject({
      ok: true,
    });
    for (const code of [0x0d, 0x85, 0x2028, 0x2029, 0x0b, 0x0c, 0]) {
      expect(parseSupportRequest({ ...good, message: `a${chr(code)}b` })).toMatchObject({
        ok: false,
        fields: { message: "invalid" },
      });
    }
  });
});

describe("parseSupportRequest", () => {
  it("trims, accepts an optional resource id and refuses control characters and long text", () => {
    expect(parseSupportRequest({ ...good, subject: "  hi  " })).toMatchObject({
      ok: true,
      value: { subject: "hi", relatedResourceId: null },
    });
    expect(parseSupportRequest({ ...good, relatedResourceId: "not-a-uuid" })).toMatchObject({
      ok: false,
    });
    expect(parseSupportRequest({ ...good, message: "a\u0000b" })).toMatchObject({ ok: false });
    expect(parseSupportRequest({ ...good, subject: "a\nb" })).toMatchObject({ ok: false });
    expect(parseSupportRequest({ ...good, message: "x".repeat(5001) })).toMatchObject({
      ok: false,
    });
    expect(parseSupportRequest({ ...good, idempotencyKey: "short" })).toMatchObject({ ok: false });
    expect(parseSupportRequest(null)).toMatchObject({ ok: false });
  });
});
