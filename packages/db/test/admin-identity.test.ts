import { expect, it } from "vitest";
import { lookupAdminBySub } from "../repositories/admin/identity";
import { useBoundTestDatabase } from "../testing/bind";
import { withTx } from "../tx";
import { newAdmin } from "./fixtures";

// Bound as admin_rw: the SELECT grant on admin_users (migration 0006) is part of the proof.
const t = useBoundTestDatabase("admin_rw");

const subOf = async (id: string): Promise<string> =>
  (
    await t.pool.query<{ cognito_sub: string }>(
      "select cognito_sub from admin_users where id = $1",
      [id],
    )
  ).rows[0]!.cognito_sub;
const lookup = (sub: string) => withTx((tx) => lookupAdminBySub(tx, sub));

it("finds the admin by cognito sub and returns exactly three fields", async () => {
  const id = await newAdmin(t.pool, "ops");
  const found = await lookup(await subOf(id));
  expect(found).toEqual({ id, role: "ops", status: "active" });
  expect(Object.keys(found!).sort()).toEqual(["id", "role", "status"]);
});

it("returns a disabled admin as it is: the caller decides", async () => {
  const id = await newAdmin(t.pool, "finance");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [id]);
  expect(await lookup(await subOf(id))).toEqual({ id, role: "finance", status: "disabled" });
});

it("returns null for an unknown sub, and for a sub of a customer", async () => {
  expect(await lookup("sub-does-not-exist")).toBeNull();
});

it("returns null, without a query, for an empty, non-string or oversized sub", async () => {
  const queried: string[] = [];
  const stub = new Proxy(
    {},
    {
      get(_target, name) {
        queried.push(String(name));
        throw new Error("a query was made");
      },
    },
  );
  for (const bad of ["", "x".repeat(129), 5 as unknown as string, undefined as unknown as string]) {
    expect(await lookupAdminBySub(stub as never, bad)).toBeNull();
  }
  expect(queried).toEqual([]);
});

it("matches exactly: case, spaces and wildcards are plain characters", async () => {
  const id = await newAdmin(t.pool, "support");
  const sub = await subOf(id);
  expect(await lookup(sub.toUpperCase())).toBeNull();
  expect(await lookup(` ${sub}`)).toBeNull();
  expect(await lookup("admin-%")).toBeNull();
});
