import { expect, it } from "vitest";
import type { Tx } from "../client";
import { lockFxRateWrites, lockPricingRuleWrites } from "../repositories/config/locks";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const admin = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "admin_rw" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it.each([
  ["fx rates", lockFxRateWrites],
  ["pricing rules", lockPricingRuleWrites],
])(
  "%s: the second transaction of a market waits for the first; another market does not wait",
  async (_, lock) => {
    const order: string[] = [];
    const first = admin(async (tx) => {
      await lock(tx, "BD");
      order.push("first has the lock");
      await sleep(400);
      order.push("first ends");
    });
    await sleep(100);
    const same = admin(async (tx) => {
      await lock(tx, "BD");
      order.push("same market has the lock");
    });
    const other = admin(async (tx) => {
      await lock(tx, "KE");
      order.push("other market has the lock");
    });
    await Promise.all([first, same, other]);
    expect(order.indexOf("other market has the lock")).toBeLessThan(order.indexOf("first ends"));
    expect(order.indexOf("same market has the lock")).toBeGreaterThan(order.indexOf("first ends"));
  },
);

it("a market that is not two capital letters is a programming error", async () => {
  await expect(admin((tx) => lockFxRateWrites(tx, "bd"))).rejects.toThrow(
    new TypeError("market: not a market code"),
  );
});
