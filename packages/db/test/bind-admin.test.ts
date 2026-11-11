import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { useBoundTestDatabase } from "../testing/bind";
import { withTx } from "../tx";

useBoundTestDatabase("admin_rw");

it("useBoundTestDatabase(role) binds the role it was given", async () => {
  const r = await withTx((tx) => tx.execute(sql`select current_user as u`));
  expect(r.rows[0]).toEqual({ u: "admin_rw" });
});
