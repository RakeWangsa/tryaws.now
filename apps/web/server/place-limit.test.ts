import { customerRepos } from "@tc/db";
import type { Tx } from "@tc/db";
import { newCustomer, runTransaction, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { PLACE_RATE_LIMITS } from "./order-actions.ts";
import { consumeAllOrNothing } from "./place-limit.ts";

// WPU-X11 follow-up (final review, LOW). The customer's limiter counts the rules in key order and does not
// undo the ones before a refusal; `order.place.web:3600` sorts before `:60`, so a purchase refused by the
// per-minute rule still used one of the 60 an hour (a double click or a script locked a customer out for the
// hour). The purchase limit is now all or nothing: the transaction rolls back when any rule refuses.

const t = useTempDatabase();
const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  runTransaction(t.db, fn, { role: "web_rw" }) as Promise<T>;
const NOW = new Date("2026-11-15T09:00:00.000Z");

const hourCount = async (customerId: string) =>
  Number(
    (
      await t.pool.query<{ n: string }>(
        "select coalesce(sum(count), 0) as n from rate_limits where scope_key = $1",
        [`customer:${customerId}:order.place.web:3600`],
      )
    ).rows[0]?.n ?? 0,
  );
const minuteCount = async (customerId: string) =>
  Number(
    (
      await t.pool.query<{ n: string }>(
        "select coalesce(sum(count), 0) as n from rate_limits where scope_key = $1",
        [`customer:${customerId}:order.place.web:60`],
      )
    ).rows[0]?.n ?? 0,
  );

describe("consumeAllOrNothing with the purchase limits", () => {
  it("sixty purchases in one minute: ten pass, fifty are refused, and the hour count stays at ten", async () => {
    const id = await newCustomer(t.pool);
    const answers = [];
    for (let i = 0; i < 60; i++) {
      answers.push(await consumeAllOrNothing(run, id, PLACE_RATE_LIMITS, NOW));
    }
    expect(answers.filter((a) => a.allowed)).toHaveLength(10);
    expect(answers.filter((a) => !a.allowed)).toHaveLength(50);
    expect(await minuteCount(id)).toBe(10);
    expect(await hourCount(id)).toBe(10);
  });

  it("the minute after, the customer still has 50 of the hour and ten more get through", async () => {
    const id = await newCustomer(t.pool);
    for (let i = 0; i < 60; i++) await consumeAllOrNothing(run, id, PLACE_RATE_LIMITS, NOW);
    const next = new Date(NOW.getTime() + 61_000);
    const answers = [];
    for (let i = 0; i < 20; i++) {
      answers.push(await consumeAllOrNothing(run, id, PLACE_RATE_LIMITS, next));
    }
    expect(answers.filter((a) => a.allowed)).toHaveLength(10);
    expect(await hourCount(id)).toBe(20);
  });

  it("parallel purchases: ten of thirty get through and the hour count is ten", async () => {
    const id = await newCustomer(t.pool);
    const answers = await Promise.all(
      Array.from({ length: 30 }, () => consumeAllOrNothing(run, id, PLACE_RATE_LIMITS, NOW)),
    );
    expect(answers.filter((a) => a.allowed)).toHaveLength(10);
    expect(await hourCount(id)).toBe(10);
  });

  it("(the plain consume it replaces: the same sixty attempts use up the whole hour)", async () => {
    const id = await newCustomer(t.pool);
    for (let i = 0; i < 60; i++) {
      await run((tx) => customerRepos(tx, id).rateLimits.consume(PLACE_RATE_LIMITS, NOW));
    }
    expect(await minuteCount(id)).toBe(10);
    expect(await hourCount(id)).toBe(60);
  });

  it("is per customer (R8): another customer's counters are untouched", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    for (let i = 0; i < 15; i++) await consumeAllOrNothing(run, a, PLACE_RATE_LIMITS, NOW);
    expect(await hourCount(b)).toBe(0);
    expect((await consumeAllOrNothing(run, b, PLACE_RATE_LIMITS, NOW)).allowed).toBe(true);
    expect(await hourCount(b)).toBe(1);
  });

  it("a failure that is not a refusal propagates, so the caller refuses as unavailable (R16)", async () => {
    const id = await newCustomer(t.pool);
    await expect(consumeAllOrNothing(run, id, [], NOW)).rejects.toThrow();
    // and a bad id is never counted
    await expect(consumeAllOrNothing(run, "not-a-uuid", PLACE_RATE_LIMITS, NOW)).rejects.toThrow();
  });
});
