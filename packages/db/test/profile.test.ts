import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import { customerRepos, type CustomerRepos } from "../repositories/customer/index";
import type { ProfileUpdate } from "../repositories/customer/profile";
import { withCustomerRepos } from "../testing/repos";
import { useTempDatabase } from "./temp-db";
import { newCustomer } from "./fixtures";

const t = useTempDatabase();
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);

it("profile.get({ lock: 'share' }) holds the customer row against an update until the transaction ends", async () => {
  const id = await newCustomer(t.pool);
  await as(id, async (r) => {
    await r.profile.get({ lock: "share" });
    await expect(
      t.pool.query("select 1 from customers where id = $1 for update nowait", [id]),
    ).rejects.toMatchObject({ code: "55P03" });
  });
  // without the option the row is not held
  await as(id, async (r) => {
    await r.profile.get();
    await expect(
      t.pool.query("select 1 from customers where id = $1 for update nowait", [id]),
    ).resolves.toBeDefined();
  });
});

it("customerRepos refuses a customer id that is not a UUID, before any query (R16)", () => {
  for (const bad of ["", "42", "not-a-uuid", " " + uuidv7(), undefined as unknown as string]) {
    expect(() => customerRepos({} as Tx, bad)).toThrow(
      new TypeError("customerRepos: the customer id is not a UUID"),
    );
  }
  expect(() => customerRepos({} as Tx, uuidv7())).not.toThrow();
});

it("profile.get gives the session customer's own row with exactly the profile fields", async () => {
  const id = await newCustomer(t.pool, { name: "Karim" });
  const p = await as(id, (r) => r.profile.get());
  expect(p).toMatchObject({
    id,
    name: "Karim",
    type: null,
    kycStatus: "none",
    riskTier: "new",
    market: "BD",
    locale: "bn",
    status: "active",
  });
  expect(Object.keys(p!).sort()).toEqual([
    "createdAt",
    "email",
    "emailVerifiedAt",
    "id",
    "kycStatus",
    "locale",
    "market",
    "name",
    "phone",
    "phoneVerifiedAt",
    "riskTier",
    "status",
    "totpEnabledAt",
    "type",
  ]);
});

it("profile.get gives null for an id with no customer row", async () => {
  expect(await as(uuidv7(), (r) => r.profile.get())).toBeNull();
});

it("profile.update sets the name and the locale; nothing to set is a validation failure", async () => {
  const id = await newCustomer(t.pool);
  const r = await as(id, (x) => x.profile.update({ name: "Rahim", locale: "en" }));
  expect(r).toMatchObject({
    ok: true,
    replayed: false,
    value: { id, name: "Rahim", locale: "en" },
  });
  expect(await as(id, (x) => x.profile.update({}))).toEqual({ ok: false, error: "validation" });
  expect(await as(id, (x) => x.profile.update({ name: undefined }))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await as(id, (x) => x.profile.update({ name: null }))).toMatchObject({
    ok: true,
    value: { id, name: null, locale: "en" },
  });
  expect(await as(uuidv7(), (x) => x.profile.update({ name: "x" }))).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("a value the database refuses reaches the caller as a DbError with its constraint", async () => {
  const id = await newCustomer(t.pool);
  await expect(as(id, (x) => x.profile.update({ locale: "fr" as "bn" }))).rejects.toMatchObject({
    name: "DbError",
    code: "23514",
    constraint: "customers_locale_check",
  });
});

// The grants of web_rw allow an update of email, phone and sessions_valid_after (migration 0006), for
// the flows of WP2-T3 and WP2-T5. The grants alone would let a caller write them through this
// method with a cast input, so the repository reads nothing but name and locale from its input.
it("profile.update writes only the name and the locale, whatever else a cast input carries (open point 13)", async () => {
  const id = await newCustomer(t.pool, { name: "Karim" });
  const guarded = () =>
    t.pool
      .query(
        "select email, phone, phone_verified_at, sessions_valid_after, kyc_status, risk_tier, market, status from customers where id = $1",
        [id],
      )
      .then((result) => result.rows[0]);
  const before = await guarded();
  const cast = {
    name: "Rahim",
    email: "other@example.test",
    phone: "000",
    sessionsValidAfter: new Date(),
  } as ProfileUpdate;
  expect(await as(id, (x) => x.profile.update(cast))).toMatchObject({
    ok: true,
    value: { id, name: "Rahim" },
  });
  expect(await guarded()).toEqual(before);
  const onlyUnknown = { email: "other@example.test" } as ProfileUpdate;
  expect(await as(id, (x) => x.profile.update(onlyUnknown))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await guarded()).toEqual(before);
});

it("profile.update is idempotent by absolute assignment: the same input twice gives the same row", async () => {
  const id = await newCustomer(t.pool);
  const first = await as(id, (x) => x.profile.update({ name: "Rahim", locale: "en" }));
  const second = await as(id, (x) => x.profile.update({ name: "Rahim", locale: "en" }));
  expect(first).toMatchObject({ ok: true, value: { id, name: "Rahim", locale: "en" } });
  expect(second).toEqual(first);
  expect(await as(id, (x) => x.profile.get())).toMatchObject({ id, name: "Rahim", locale: "en" });
});
