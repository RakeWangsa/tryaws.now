import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { useTempDatabase } from "./temp-db";
import { newCustomer } from "./fixtures";

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);
const NOW = new Date("2026-11-11T10:00:00.000Z");

it("setVerifiedPhone stores the number and the time, replaces an older number, and changes nothing else", async () => {
  const id = await newCustomer(t.pool, { name: "Karim", phone: "+8801612345678" });
  const r = await as(id, (x) =>
    x.profile.setVerifiedPhone({ phone: "+8801712345678", verifiedAt: NOW }),
  );
  expect(r).toMatchObject({
    ok: true,
    replayed: false,
    value: { id, name: "Karim", phone: "+8801712345678", phoneVerifiedAt: NOW },
  });
  expect(
    await as(id, (x) => x.profile.setVerifiedPhone({ phone: "+8801712345678", verifiedAt: NOW })),
  ).toEqual(r); // same input, same state
  const row = (
    await t.pool.query("select email, kyc_status, status from customers where id = $1", [id])
  ).rows[0];
  expect(row).toMatchObject({ kyc_status: "none", status: "active" });
});

it("a number that is not +880 and ten digits is a validation failure; a missing customer is not found", async () => {
  const id = await newCustomer(t.pool);
  for (const phone of ["01712345678", "+8801712", "+880171234567a", "+88017123456789"]) {
    expect(await as(id, (x) => x.profile.setVerifiedPhone({ phone, verifiedAt: NOW }))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(
    await as(uuidv7(), (x) =>
      x.profile.setVerifiedPhone({ phone: "+8801712345678", verifiedAt: NOW }),
    ),
  ).toEqual({ ok: false, error: "not_found" });
});
