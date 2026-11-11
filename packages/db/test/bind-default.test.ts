import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { useBoundTestDatabase } from "../testing/bind";
import { withTx } from "../tx";

useBoundTestDatabase(); // no argument: its default decides the grants under which every later endpoint test runs

// This must stay the first test of the file: a test that binds another database or role before it
// would hide a wrong default.
it("useBoundTestDatabase() with no argument binds web_rw", async () => {
  const r = await withTx((tx) => tx.execute(sql`select current_user as u`));
  expect(r.rows[0]).toEqual({ u: "web_rw" });
});
