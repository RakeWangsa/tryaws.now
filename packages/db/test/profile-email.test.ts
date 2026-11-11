import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);

it("setEmail stores the new address, is idempotent, and changes nothing else (WP2-T5)", async () => {
  const id = await newCustomer(t.pool, { name: "Karim", phone: "+8801612345678" });
  const first = await as(id, (x) => x.profile.setEmail("new@example.test"));
  expect(first).toMatchObject({
    ok: true,
    value: { id, email: "new@example.test", name: "Karim", phone: "+8801612345678" },
  });
  expect(await as(id, (x) => x.profile.setEmail("new@example.test"))).toEqual(first);
  const row = (
    await t.pool.query(
      "select kyc_status, status, phone_verified_at from customers where id = $1",
      [id],
    )
  ).rows[0];
  expect(row).toMatchObject({ kyc_status: "none", status: "active", phone_verified_at: null });
});

it("setEmail refuses an address that is not lower case or not an address, before any query", async () => {
  const id = await newCustomer(t.pool);
  for (const bad of ["", "no-at", "A@Example.test", "a b@example.test", "a@@b.test", 5 as never]) {
    expect(await as(id, (x) => x.profile.setEmail(bad))).toEqual({
      ok: false,
      error: "validation",
    });
  }
});

it("setEmail changes only the session customer's own row", async () => {
  const a = await newCustomer(t.pool, { email: "a-own@example.test" });
  const b = await newCustomer(t.pool, { email: "b-own@example.test" });
  await as(b, (x) => x.profile.setEmail("b-new@example.test"));
  const rows = (await t.pool.query("select id, email from customers where id in ($1, $2)", [a, b]))
    .rows;
  expect(rows.find((r) => r.id === a).email).toBe("a-own@example.test");
  expect(rows.find((r) => r.id === b).email).toBe("b-new@example.test");
});
