import type { CustomerSession } from "@tc/auth";
import type { CustomerLimit } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  SUPPORT_CLOSE_LIMITS,
  SUPPORT_REPLY_LIMITS,
  addSupportMessageCore,
  closeSupportRequestCore,
  type SupportThreadDeps,
  type SupportThreadRepos,
} from "./support-thread-actions.ts";

// WPU-Z6: the cores of the reply and the close of a support request in the panel. The repositories are a
// small fake world keyed by customer: a request of another customer is, for the session's repositories, a
// request that does not exist (packages/db proves that against PostgreSQL in support-repo.test.ts).

const NOW = new Date("2026-11-14T10:00:00Z");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const MINE = "0191a000-0000-7000-8000-0000000000e1";
const THEIRS = "0191a000-0000-7000-8000-0000000000e2";
const KEY = "0191a000-0000-7000-8000-0000000000aa";
const MESSAGE_ID = "0191a000-0000-5000-8000-0000000000bb";

const sessionOf = (customerId: string): CustomerSession => ({
  customerId,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: NOW,
});

interface Over {
  signedIn?: boolean;
  allowed?: boolean;
  replayed?: boolean;
  repoError?: "validation" | "conflict" | "not_found";
  auditRefused?: boolean;
  as?: string;
}

function world(over: Over = {}) {
  const calls: string[] = [];
  const opened: string[] = [];
  const limits: CustomerLimit[][] = [];
  // The requests of each customer: the fake repositories answer only the scope's own.
  const owned: Record<string, string[]> = { [A]: [MINE], [B]: [THEIRS] };
  const reposFor = (customerId: string): SupportThreadRepos =>
    ({
      support: {
        addMessage: async (input: { requestId: string; idempotencyKey: string; body: string }) => {
          calls.push(`addMessage:${input.requestId}:${input.body}`);
          if (over.repoError) return { ok: false, error: over.repoError };
          if (!(owned[customerId] ?? []).includes(input.requestId))
            return { ok: false, error: "not_found" };
          return { ok: true, replayed: over.replayed === true, value: { id: MESSAGE_ID } };
        },
        close: async (requestId: string) => {
          calls.push(`close:${requestId}`);
          if (over.repoError) return { ok: false, error: over.repoError };
          if (!(owned[customerId] ?? []).includes(requestId))
            return { ok: false, error: "not_found" };
          return { ok: true, replayed: over.replayed === true, value: { id: requestId } };
        },
      },
      audit: {
        record: async (i: { action: string; targetType?: string; targetId?: string }) => {
          calls.push(`audit:${i.action}:${i.targetType}:${i.targetId}`);
          if (over.auditRefused) return { ok: false, error: "validation" };
          return { ok: true, replayed: false, value: { id: "audit-1" } };
        },
      },
      rateLimits: {
        consume: async (l: readonly CustomerLimit[]) => {
          calls.push("limit");
          limits.push([...l]);
          return { allowed: over.allowed !== false } as never;
        },
      },
    }) as unknown as SupportThreadRepos;
  const deps: SupportThreadDeps = {
    authenticate: async () => {
      calls.push("auth");
      return over.signedIn === false ? null : sessionOf(over.as ?? A);
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      opened.push(customerId);
      return fn(reposFor(customerId));
    },
  };
  return { deps, calls, opened, limits };
}

const reply = { requestId: MINE, idempotencyKey: KEY, body: "Any news?" };

describe("addSupportMessageCore", () => {
  it("authenticates, validates, rate limits, writes and audits, in that order (R9)", async () => {
    const w = world();
    expect(await addSupportMessageCore(w.deps, reply)).toEqual({
      ok: true,
      id: MESSAGE_ID,
      replayed: false,
    });
    expect(w.calls).toEqual([
      "auth",
      "limit",
      `addMessage:${MINE}:Any news?`,
      `audit:support.reply:support_request:${MINE}`,
    ]);
    expect(w.limits).toEqual([[{ action: "support.reply", limit: 10, windowSeconds: 3600 }]]);
  });

  it("takes the customer from the session, never from the input (R8)", async () => {
    const w = world();
    await addSupportMessageCore(w.deps, { ...reply, customerId: B });
    expect(w.opened).toEqual([A]);
  });

  it("refuses without a session before anything else", async () => {
    const w = world({ signedIn: false });
    expect(await addSupportMessageCore(w.deps, reply)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(w.calls).toEqual(["auth"]);
    expect(w.opened).toEqual([]);
  });

  it("refuses a bad form before the limit and the write", async () => {
    const bad: unknown[] = [
      { ...reply, body: "   " },
      { ...reply, body: "x".repeat(5001) },
      { ...reply, body: "a‮b" },
      { ...reply, body: 7 },
      { ...reply, idempotencyKey: "" },
      { ...reply, idempotencyKey: "has space" },
      { ...reply, idempotencyKey: "k".repeat(129) },
      { ...reply, requestId: "not-a-uuid" },
      { ...reply, requestId: undefined },
      null,
      "text",
    ];
    for (const raw of bad) {
      const w = world();
      const r = await addSupportMessageCore(w.deps, raw);
      expect(r, JSON.stringify(raw)).toMatchObject({ ok: false, error: "validation" });
      expect(w.calls).toEqual(["auth"]);
    }
  });

  it("names the field that is wrong", async () => {
    const w = world();
    expect(await addSupportMessageCore(w.deps, { ...reply, body: "" })).toEqual({
      ok: false,
      error: "validation",
      fields: { body: "invalid" },
    });
  });

  it("accepts a body of 5000 characters and CRLF line ends", async () => {
    const w = world();
    expect(await addSupportMessageCore(w.deps, { ...reply, body: "x".repeat(5000) })).toMatchObject(
      { ok: true },
    );
    const crlf = world();
    expect(
      await addSupportMessageCore(crlf.deps, { ...reply, body: "line 1\r\nline 2" }),
    ).toMatchObject({ ok: true });
  });

  it("writes nothing when the limit of 10 replies an hour is used up", async () => {
    const w = world({ allowed: false });
    expect(await addSupportMessageCore(w.deps, reply)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(w.calls).toEqual(["auth", "limit"]);
  });

  it("cross-tenant: another customer's request answers like a missing one and nothing is audited (R8)", async () => {
    for (const requestId of [THEIRS, "0191a000-0000-7000-8000-0000000000ff"]) {
      const w = world();
      expect(await addSupportMessageCore(w.deps, { ...reply, requestId })).toEqual({
        ok: false,
        error: "not_found",
      });
      expect(w.opened).toEqual([A]);
      expect(w.calls.some((c) => c.startsWith("audit:"))).toBe(false);
    }
  });

  it("a replay audits nothing (R7)", async () => {
    const w = world({ replayed: true });
    expect(await addSupportMessageCore(w.deps, reply)).toEqual({
      ok: true,
      id: MESSAGE_ID,
      replayed: true,
    });
    expect(w.calls.some((c) => c.startsWith("audit:"))).toBe(false);
  });

  it("the same key with another text is a conflict", async () => {
    const w = world({ repoError: "conflict" });
    expect(await addSupportMessageCore(w.deps, reply)).toEqual({ ok: false, error: "conflict" });
  });

  it("fails closed when the audit entry is refused or the store throws (R16)", async () => {
    const w = world({ auditRefused: true });
    expect(await addSupportMessageCore(w.deps, reply)).toEqual({
      ok: false,
      error: "unavailable",
    });
    const broken = world();
    broken.deps.store = async () => {
      throw new Error("db down");
    };
    expect(await addSupportMessageCore(broken.deps, reply)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("the audit entry holds the request id, never the text (R14)", async () => {
    const w = world();
    await addSupportMessageCore(w.deps, { ...reply, body: "my secret text" });
    const audit = w.calls.find((c) => c.startsWith("audit:"));
    expect(audit).toBe(`audit:support.reply:support_request:${MINE}`);
  });
});

describe("closeSupportRequestCore", () => {
  it("authenticates, validates, rate limits, closes and audits, in that order (R9)", async () => {
    const w = world();
    expect(await closeSupportRequestCore(w.deps, { requestId: MINE })).toEqual({
      ok: true,
      id: MINE,
      replayed: false,
    });
    expect(w.calls).toEqual([
      "auth",
      "limit",
      `close:${MINE}`,
      `audit:support.close:support_request:${MINE}`,
    ]);
    expect(w.limits).toEqual([[{ action: "support.close", limit: 30, windowSeconds: 3600 }]]);
  });

  it("takes the customer from the session, never from the input (R8)", async () => {
    const w = world();
    await closeSupportRequestCore(w.deps, { requestId: MINE, customerId: B });
    expect(w.opened).toEqual([A]);
  });

  it("refuses without a session, a bad id, and a used-up limit", async () => {
    const out = world({ signedIn: false });
    expect(await closeSupportRequestCore(out.deps, { requestId: MINE })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(out.calls).toEqual(["auth"]);
    for (const raw of [{ requestId: "x" }, {}, null]) {
      const w = world();
      expect(await closeSupportRequestCore(w.deps, raw)).toMatchObject({
        ok: false,
        error: "validation",
      });
      expect(w.calls).toEqual(["auth"]);
    }
    const limited = world({ allowed: false });
    expect(await closeSupportRequestCore(limited.deps, { requestId: MINE })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limited.calls).toEqual(["auth", "limit"]);
  });

  it("cross-tenant: another customer's request answers like a missing one and nothing is audited (R8)", async () => {
    const w = world();
    expect(await closeSupportRequestCore(w.deps, { requestId: THEIRS })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(w.opened).toEqual([A]);
    expect(w.calls.some((c) => c.startsWith("audit:"))).toBe(false);
  });

  it("closing a closed request is a replay and audits nothing (R7)", async () => {
    const w = world({ replayed: true });
    expect(await closeSupportRequestCore(w.deps, { requestId: MINE })).toEqual({
      ok: true,
      id: MINE,
      replayed: true,
    });
    expect(w.calls.some((c) => c.startsWith("audit:"))).toBe(false);
  });

  it("fails closed when the audit entry is refused (R16)", async () => {
    const w = world({ auditRefused: true });
    expect(await closeSupportRequestCore(w.deps, { requestId: MINE })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("the limits", () => {
  it("are per customer, one family with the request form: 10 replies and 30 closes an hour", () => {
    expect(SUPPORT_REPLY_LIMITS).toEqual([
      { action: "support.reply", limit: 10, windowSeconds: 3600 },
    ]);
    expect(SUPPORT_CLOSE_LIMITS).toEqual([
      { action: "support.close", limit: 30, windowSeconds: 3600 },
    ]);
  });
});
