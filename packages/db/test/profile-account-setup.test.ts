import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { useTempDatabase } from "./temp-db";
import { newCustomer } from "./fixtures";

// WPU-X11: the two facts of the account setup that the server stores on the customers row (the buy
// condition is e-mail verified + mobile verified + authenticator on). Written as web_rw, through the
// tenant-scoped profile repository only (R8).

const t = useTempDatabase();
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);
const AT = new Date("2026-11-14T10:00:00.000Z");
const LATER = new Date("2026-11-15T10:00:00.000Z");

const row = async (id: string) =>
  (
    await t.pool.query(
      "select email_verified_at, totp_enabled_at, kyc_status, phone_verified_at from customers where id = $1",
      [id],
    )
  ).rows[0];

it("a new customer has neither fact, and profile.get gives both as null", async () => {
  const id = await newCustomer(t.pool);
  const p = await as(id, (r) => r.profile.get());
  expect(p).toMatchObject({ emailVerifiedAt: null, totpEnabledAt: null });
});

it("markEmailVerified keeps the first time: a second call changes nothing (R7)", async () => {
  const id = await newCustomer(t.pool);
  expect(await as(id, (r) => r.profile.markEmailVerified(AT))).toMatchObject({
    ok: true,
    value: { emailVerifiedAt: AT },
  });
  expect(await as(id, (r) => r.profile.markEmailVerified(LATER))).toMatchObject({
    ok: true,
    value: { emailVerifiedAt: AT },
  });
  expect((await row(id)).email_verified_at).toEqual(AT);
  const p = await as(id, (r) => r.profile.get());
  expect(p?.emailVerifiedAt).toEqual(AT);
});

it("setTotpEnabled sets and clears the authenticator time and touches nothing else", async () => {
  const id = await newCustomer(t.pool);
  const before = await row(id);
  expect(await as(id, (r) => r.profile.setTotpEnabled(AT))).toMatchObject({
    ok: true,
    value: { totpEnabledAt: AT },
  });
  expect(await row(id)).toEqual({ ...before, totp_enabled_at: AT });
  // The same input again gives the same state (absolute assignment).
  await as(id, (r) => r.profile.setTotpEnabled(AT));
  expect((await row(id)).totp_enabled_at).toEqual(AT);
  expect(await as(id, (r) => r.profile.setTotpEnabled(null))).toMatchObject({
    ok: true,
    value: { totpEnabledAt: null },
  });
  expect(await row(id)).toEqual(before);
});

it("refuses a value that is not a valid Date, before any query (R16)", async () => {
  const id = await newCustomer(t.pool);
  for (const bad of [new Date(Number.NaN), "2026-11-14", 0, undefined]) {
    expect(await as(id, (r) => r.profile.setTotpEnabled(bad as unknown as Date))).toEqual({
      ok: false,
      error: "validation",
    });
    expect(await as(id, (r) => r.profile.markEmailVerified(bad as unknown as Date))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(await row(id)).toMatchObject({ email_verified_at: null, totp_enabled_at: null });
});

it("cross-tenant (R8): customer B's calls never change customer A's row", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  await as(b, (r) => r.profile.setTotpEnabled(AT));
  await as(b, (r) => r.profile.markEmailVerified(AT));
  expect(await row(a)).toMatchObject({ email_verified_at: null, totp_enabled_at: null });
  expect(await row(b)).toMatchObject({ email_verified_at: AT, totp_enabled_at: AT });
});

it("a customer id with no row answers not_found", async () => {
  const ghost = "0190bbbb-0000-7000-8000-00000000fffe";
  expect(await as(ghost, (r) => r.profile.setTotpEnabled(AT))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await as(ghost, (r) => r.profile.markEmailVerified(AT))).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("migration 0030 filled email_verified_at from the earliest sign-in in the audit log", async () => {
  // The temp database is migrated before the test: the backfill ran on an empty table. Running its
  // statement again proves it is idempotent and fills only from a sign-in row.
  const signed = await newCustomer(t.pool);
  const never = await newCustomer(t.pool);
  for (const at of ["2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z"]) {
    await t.pool.query(
      "insert into audit_log (id, actor_type, actor_id, action, created_at) values (gen_random_uuid(), 'customer', $1, 'auth.sign_in', $2)",
      [signed, at],
    );
  }
  const file = readFileSync(
    resolve(import.meta.dirname, "../migrations/0030_account_setup.sql"),
    "utf8",
  );
  const backfill = file.split("--> statement-breakpoint").at(-1) as string;
  expect(backfill).toContain("UPDATE customers c");
  await t.pool.query(backfill);
  await t.pool.query(backfill);
  expect((await row(signed)).email_verified_at).toEqual(new Date("2026-11-01T00:00:00Z"));
  expect((await row(never)).email_verified_at).toBeNull();
});
