import type { CustomerSession } from "@tc/auth";
import { describe, expect, it } from "vitest";
import {
  revealDatabasePasswordCore,
  type DatabaseAccessDeps,
  type RevealPort,
} from "./databases-access.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const DB = "0190aaaa-0000-7000-8000-0000000000d1";

const session = (signedInAt = new Date(NOW.getTime() - 60_000)): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});

function world(
  over: {
    session?: CustomerSession | null;
    owned?: "active" | "stopped" | "creating" | null;
    allowed?: boolean;
    reveal?: RevealPort | null;
  } = {},
) {
  const calls: string[] = [];
  const deps: DatabaseAccessDeps = {
    authenticate: async () => (over.session === undefined ? session() : over.session),
    now: () => NOW,
    ownedDatabase: async (customerId, resourceId) => {
      calls.push(`owned:${customerId}:${resourceId}`);
      return over.owned === undefined ? "active" : over.owned;
    },
    rateLimit: async () => {
      calls.push("rate");
      return over.allowed !== false;
    },
    reveal:
      over.reveal === undefined
        ? async (input) => {
            calls.push(`reveal:${input.customerId}:${input.resourceId}`);
            return { ok: true, value: { username: "tcadmin", password: "s3cret-value" } };
          }
        : over.reveal,
  };
  return { deps, calls };
}

describe("revealDatabasePasswordCore", () => {
  it("authenticates, needs a fresh sign-in, checks ownership, rates and only then reveals, once, no-store (U9, R9)", async () => {
    const { deps, calls } = world();
    expect(await revealDatabasePasswordCore(deps, { resourceId: DB })).toEqual({
      ok: true,
      username: "tcadmin",
      password: "s3cret-value",
      cacheControl: "no-store",
    });
    expect(calls).toEqual([`owned:${CUSTOMER}:${DB}`, "rate", `reveal:${CUSTOMER}:${DB}`]);
  });

  it("takes the customer id from the session, never from the input (R8)", async () => {
    const { deps, calls } = world();
    await revealDatabasePasswordCore(deps, {
      resourceId: DB,
      customerId: "99999999-9999-4999-8999-999999999999",
    });
    expect(calls.join(" ")).not.toContain("99999999");
  });

  it("refuses without a session, with a stale sign-in and with a bad id, touching nothing", async () => {
    const none = world({ session: null });
    expect(await revealDatabasePasswordCore(none.deps, { resourceId: DB })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    const stale = world({ session: session(new Date(NOW.getTime() - 3 * 3_600_000)) });
    expect(await revealDatabasePasswordCore(stale.deps, { resourceId: DB })).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    const bad = world();
    expect(await revealDatabasePasswordCore(bad.deps, { resourceId: "x" })).toEqual({
      ok: false,
      error: "validation",
    });
    for (const w of [none, stale, bad]) expect(w.calls).toEqual([]);
  });

  it("another customer's database and a missing one give one answer and never reach the port (R8)", async () => {
    const { deps, calls } = world({ owned: null });
    expect(await revealDatabasePasswordCore(deps, { resourceId: DB })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(calls.some((c) => c.startsWith("reveal"))).toBe(false);
  });

  it("says not_ready for a database that is not running, and is rate limited", async () => {
    expect(
      await revealDatabasePasswordCore(world({ owned: "creating" }).deps, { resourceId: DB }),
    ).toEqual({ ok: false, error: "not_ready" });
    expect(
      await revealDatabasePasswordCore(world({ allowed: false }).deps, { resourceId: DB }),
    ).toEqual({ ok: false, error: "rate_limited" });
  });

  it("refuses when the transport is not wired, and maps a failure to a fixed key without its text (R16, U6)", async () => {
    expect(
      await revealDatabasePasswordCore(world({ reveal: null }).deps, { resourceId: DB }),
    ).toEqual({ ok: false, error: "unavailable" });
    const boom = world({ reveal: async () => ({ ok: false, error: "arn:aws:lightsail:1234" }) });
    const result = await revealDatabasePasswordCore(boom.deps, { resourceId: DB });
    expect(result).toEqual({ ok: false, error: "unavailable" });
    const thrown = world({
      reveal: async () => {
        throw new Error("password=abc");
      },
    });
    expect(
      JSON.stringify(await revealDatabasePasswordCore(thrown.deps, { resourceId: DB })),
    ).not.toContain("abc");
  });

  it("validates with zod before the ownership read: padded ids are trimmed, other shapes are refused", async () => {
    const { deps, calls } = world();
    await revealDatabasePasswordCore(deps, { resourceId: ` ${DB} `, x: 1 });
    expect(calls[0]).toBe(`owned:${CUSTOMER}:${DB}`);
    const bad = world();
    for (const raw of [null, [], {}, { resourceId: [DB] }, { resourceId: "x" }]) {
      expect(await revealDatabasePasswordCore(bad.deps, raw)).toEqual({
        ok: false,
        error: "validation",
      });
    }
    expect(bad.calls).toEqual([]);
  });
});
