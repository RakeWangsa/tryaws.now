import { runTransaction, useTempDatabase } from "@tc/db/testing";
import type { Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import { enforceAuthLimit } from "./limits.ts";

// NEEDS THE DATABASE (pnpm db:up && pnpm db:migrate): the real limiter on rate_limits, as role web_rw.
const t = useTempDatabase();
const KEY = "k".repeat(40);
const clock = { now: () => new Date("2026-11-12T10:00:00.000Z") };
const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  runTransaction(t.db, fn, { role: "web_rw" }) as Promise<T>;
const who = (ip: string, email: string) => ({ ip, email });

describe("enforceAuthLimit against the database", () => {
  it("six sign-ups from one address give five allowed and one refused with a retry time", async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await enforceAuthLimit(run, KEY, clock, "signup", who("198.51.100.7", `u${i}@x.test`)),
      );
    }
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    const last = results[5];
    expect(last?.allowed).toBe(false);
    if (last && !last.allowed) {
      expect(last.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(last.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("the third sign-up for one email from different addresses is refused by the email rule", async () => {
    const a = await enforceAuthLimit(run, KEY, clock, "signup", who("198.51.100.1", "e@x.test"));
    const b = await enforceAuthLimit(run, KEY, clock, "signup", who("198.51.100.2", "e@x.test"));
    const c = await enforceAuthLimit(run, KEY, clock, "signup", who("198.51.100.3", "e@x.test"));
    const d = await enforceAuthLimit(run, KEY, clock, "signup", who("198.51.100.4", "e@x.test"));
    expect([a.allowed, b.allowed, c.allowed, d.allowed]).toEqual([true, true, true, false]);
  });

  it("the pair rule: the same email from two addresses has two pair counters, the ceiling stops the sum", async () => {
    for (let i = 0; i < 8; i++) {
      expect(
        (await enforceAuthLimit(run, KEY, clock, "signin", who("198.51.100.1", "p@x.test")))
          .allowed,
      ).toBe(true);
    }
    // The ninth attempt from the same address is refused; another address still has its own pair counter.
    expect(
      (await enforceAuthLimit(run, KEY, clock, "signin", who("198.51.100.1", "p@x.test"))).allowed,
    ).toBe(false);
    expect(
      (await enforceAuthLimit(run, KEY, clock, "signin", who("198.51.100.2", "p@x.test"))).allowed,
    ).toBe(true);
  });

  it("the key table holds neither the address nor the email", async () => {
    await enforceAuthLimit(run, KEY, clock, "forgot", who("198.51.100.9", "secret@x.test"));
    const rows = await t.pool.query<{ scope_key: string }>("select scope_key from rate_limits");
    for (const row of rows.rows) {
      expect(row.scope_key).not.toContain("198.51.100.9");
      expect(row.scope_key).not.toContain("secret");
    }
  });
});
