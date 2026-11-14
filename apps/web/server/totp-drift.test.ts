import { customerRepos } from "@tc/db";
import type { AuditRepo, ProfileRepo } from "@tc/db";
import { newCustomer, runTransaction, useTempDatabase } from "@tc/db/testing";
import type { Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import { clearTotpDrift } from "./totp-drift.ts";

// WPU-X11 round 2 (security review, finding 2): the platform copy of the authenticator is cleared when
// Cognito shows it is off. Part one with fake repositories (what is written, in which order, what is
// refused); part two against PostgreSQL as web_rw (the grants and the real rows).

const NOW = new Date("2026-11-14T12:00:00.000Z");
const ON = new Date("2026-11-13T12:00:00.000Z");

function fakes(
  over: { totpEnabledAt?: Date | null; setFails?: boolean; auditFails?: boolean } = {},
) {
  const calls: string[] = [];
  const audits: unknown[] = [];
  const profile = {
    get: async () => ({
      id: "c",
      totpEnabledAt: over.totpEnabledAt === undefined ? ON : over.totpEnabledAt,
    }),
    setTotpEnabled: async (at: Date | null) => {
      calls.push(`setTotpEnabled:${at === null ? "null" : "time"}`);
      return over.setFails === true
        ? { ok: false, error: "not_found" }
        : { ok: true, replayed: false, value: {} };
    },
  } as unknown as ProfileRepo;
  const audit = {
    record: async (input: unknown) => {
      calls.push("audit");
      audits.push(input);
      return over.auditFails === true
        ? { ok: false, error: "validation" }
        : { ok: true, replayed: false, value: { id: "a" } };
    },
  } as unknown as AuditRepo;
  const noticed: Date[] = [];
  const notify = async (at: Date) => {
    calls.push("notify");
    noticed.push(at);
  };
  return { repos: { profile, audit }, calls, audits, notify, noticed };
}

describe("clearTotpDrift", () => {
  it("clears the copy, audits it with the way it was seen and no secret, and tells the customer", async () => {
    const f = fakes();
    expect(await clearTotpDrift(f.repos, { via: "sign_in", at: NOW, notify: f.notify })).toBe(true);
    expect(f.calls).toEqual(["setTotpEnabled:null", "audit", "notify"]);
    expect(f.audits).toEqual([
      { action: "auth.totp_drift", targetType: "customer", metadata: { via: "sign_in" } },
    ]);
    expect(f.noticed).toEqual([NOW]);
  });

  it("does nothing when the copy is already off (a second sighting writes no second row)", async () => {
    const f = fakes({ totpEnabledAt: null });
    expect(
      await clearTotpDrift(f.repos, { via: "purchase_check", at: NOW, notify: f.notify }),
    ).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("throws when a write is refused, so the caller's transaction rolls back (R16)", async () => {
    await expect(
      clearTotpDrift(fakes({ setFails: true }).repos, {
        via: "sign_in",
        at: NOW,
        notify: async () => {},
      }),
    ).rejects.toThrow();
    await expect(
      clearTotpDrift(fakes({ auditFails: true }).repos, {
        via: "sign_in",
        at: NOW,
        notify: async () => {},
      }),
    ).rejects.toThrow();
  });

  it("a thrown notice also rolls back: no copy cleared without the customer being told", async () => {
    const f = fakes();
    await expect(
      clearTotpDrift(f.repos, {
        via: "sign_in",
        at: NOW,
        notify: async () => {
          throw new Error("queue down");
        },
      }),
    ).rejects.toThrow();
  });
});

describe("clearTotpDrift against the database (web_rw)", () => {
  const t = useTempDatabase();
  const asWeb = <T>(fn: (tx: Tx) => Promise<T>) =>
    runTransaction(t.db, fn, { role: "web_rw" }) as Promise<T>;
  const row = async (id: string) =>
    (await t.pool.query("select totp_enabled_at, kyc_status from customers where id = $1", [id]))
      .rows[0];
  const auditRows = async (id: string) =>
    (
      await t.pool.query(
        "select action, metadata from audit_log where actor_id = $1 and action = 'auth.totp_drift'",
        [id],
      )
    ).rows;

  it("clears the customer's own copy and writes one audit row, and a repeat writes nothing", async () => {
    const id = await newCustomer(t.pool, { totp_enabled_at: ON.toISOString() });
    const other = await newCustomer(t.pool, { totp_enabled_at: ON.toISOString() });
    const notified: Date[] = [];
    const run = () =>
      asWeb((tx) =>
        clearTotpDrift(customerRepos(tx, id), {
          via: "purchase_check",
          at: NOW,
          notify: async (at) => {
            notified.push(at);
          },
        }),
      );
    expect(await run()).toBe(true);
    expect((await row(id)).totp_enabled_at).toBeNull();
    expect(await auditRows(id)).toEqual([
      { action: "auth.totp_drift", metadata: { via: "purchase_check" } },
    ]);
    expect(await run()).toBe(false);
    expect(await auditRows(id)).toHaveLength(1);
    expect(notified).toEqual([NOW]);
    // Cross-tenant (R8): the other customer's copy is untouched.
    expect((await row(other)).totp_enabled_at).not.toBeNull();
    expect(await auditRows(other)).toEqual([]);
  });
});
