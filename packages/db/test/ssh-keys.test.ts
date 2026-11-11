import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { useTempDatabase } from "./temp-db";
import { newCustomer } from "./fixtures";

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);
const key = { name: "laptop", publicKey: "ssh-ed25519 AAAAC3laptop", fingerprint: "SHA256:laptop" };

it("add creates a key; the same key again is a replay of the same row", async () => {
  const c = await newCustomer(t.pool);
  const first = await as(c, (r) => r.sshKeys.add(key));
  expect(first).toMatchObject({ ok: true, replayed: false, value: key });
  const again = await as(c, (r) => r.sshKeys.add(key));
  expect(again).toEqual({ ok: true, replayed: true, value: first.ok ? first.value : null });
});

it("the same fingerprint with another name or key is a conflict", async () => {
  const c = await newCustomer(t.pool);
  await as(c, (r) => r.sshKeys.add(key));
  expect(await as(c, (r) => r.sshKeys.add({ ...key, name: "desktop" }))).toEqual({
    ok: false,
    error: "conflict",
  });
});

it("a replay inside a longer transaction does not abort it (ON CONFLICT, not a caught 23505)", async () => {
  const c = await newCustomer(t.pool);
  const profile = await as(c, async (r) => {
    await r.sshKeys.add(key);
    await r.sshKeys.add(key);
    return r.profile.get();
  });
  expect(profile).toMatchObject({ id: c });
});

it("two customers may hold the same key", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  expect(await as(a, (r) => r.sshKeys.add(key))).toMatchObject({ ok: true, replayed: false });
  expect(await as(b, (r) => r.sshKeys.add(key))).toMatchObject({ ok: true, replayed: false });
});

// The replay read of add is a statement of its own, and the cross-tenant proof never sends it (its
// add case runs once per customer), so this test is what holds its customer condition (R8).
it("a replay gives the customer's own key, also when another customer holds the same fingerprint", async () => {
  const other = await newCustomer(t.pool); // first, so its row and its id come before the owner's
  const owner = await newCustomer(t.pool);
  const theirs = await as(other, (r) => r.sshKeys.add(key));
  const first = await as(owner, (r) => r.sshKeys.add(key));
  const again = await as(owner, (r) => r.sshKeys.add(key));
  expect(theirs.ok && first.ok && theirs.value.id !== first.value.id).toBe(true);
  expect(again).toEqual({ ok: true, replayed: true, value: first.ok ? first.value : null });
});

it("list gives own keys oldest first; get finds one; remove deletes it once", async () => {
  const c = await newCustomer(t.pool);
  const one = await as(c, (r) => r.sshKeys.add({ ...key, fingerprint: "SHA256:one" }));
  await as(c, (r) => r.sshKeys.add({ ...key, name: "two", fingerprint: "SHA256:two" }));
  expect((await as(c, (r) => r.sshKeys.list())).map((k) => k.fingerprint)).toEqual([
    "SHA256:one",
    "SHA256:two",
  ]);
  const id = one.ok ? one.value.id : "";
  expect(await as(c, (r) => r.sshKeys.get(id))).toMatchObject({ id, fingerprint: "SHA256:one" });
  expect(await as(c, (r) => r.sshKeys.remove(id))).toEqual({
    ok: true,
    replayed: false,
    value: { id },
  });
  expect(await as(c, (r) => r.sshKeys.remove(id))).toEqual({ ok: false, error: "not_found" });
  expect(await as(c, (r) => r.sshKeys.get(id))).toBeNull();
});

it("an id that is not a UUID is not found, without a database error", async () => {
  const c = await newCustomer(t.pool);
  expect(await as(c, (r) => r.sshKeys.get("abc"))).toBeNull();
  expect(await as(c, (r) => r.sshKeys.remove("abc"))).toEqual({ ok: false, error: "not_found" });
});
