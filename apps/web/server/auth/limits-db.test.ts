import { runTransaction, useTempDatabase } from "@tc/db/testing";
import type { Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import { enforceAuthLimit, peekAuthLimit, releaseAuthLimit } from "./limits.ts";

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

  // WPU-X11 round 2: only failed codes are counted, so the sign-in asks first (peek) and counts afterwards.
  it("signin_code: five counted failures fill the 15 minute rule; a peek adds nothing and the sixth is refused", async () => {
    const mine = who("198.51.100.20", "code@x.test");
    for (let i = 0; i < 5; i++) {
      expect((await peekAuthLimit(run, KEY, clock, "signin_code", mine)).allowed).toBe(true);
      expect((await enforceAuthLimit(run, KEY, clock, "signin_code", mine)).allowed).toBe(true);
    }
    for (let i = 0; i < 3; i++) {
      const out = await peekAuthLimit(run, KEY, clock, "signin_code", mine);
      expect(out.allowed).toBe(false);
      if (!out.allowed) expect(out.retryAfterSeconds).toBeLessThanOrEqual(900);
    }
    // Another address is the same account: the rule is per address typed, not per network.
    expect(
      (await peekAuthLimit(run, KEY, clock, "signin_code", who("203.0.113.5", "code@x.test")))
        .allowed,
    ).toBe(false);
    // Another account is not affected.
    expect(
      (await peekAuthLimit(run, KEY, clock, "signin_code", who("198.51.100.20", "other@x.test")))
        .allowed,
    ).toBe(true);
  });

  it("signin_code: the day rule stops the twenty-first failure over several quarter hours", async () => {
    const mine = who("198.51.100.21", "day@x.test");
    let now = new Date("2026-11-12T00:00:00.000Z");
    const at = { now: () => now };
    for (let quarter = 0; quarter < 4; quarter++) {
      for (let i = 0; i < 5; i++) {
        expect((await enforceAuthLimit(run, KEY, at, "signin_code", mine)).allowed).toBe(true);
      }
      now = new Date(now.getTime() + 15 * 60_000);
      // A new quarter hour: the short rule is empty again while the day rule fills up.
      if (quarter < 3)
        expect((await peekAuthLimit(run, KEY, at, "signin_code", mine)).allowed).toBe(true);
    }
    // 20 failures counted: the day rule is full although the current quarter hour is empty.
    const out = await peekAuthLimit(run, KEY, at, "signin_code", mine);
    expect(out.allowed).toBe(false);
    if (!out.allowed) expect(out.retryAfterSeconds).toBeGreaterThan(900);
  });

  // The review of the sign-in: the attempt is reserved with one atomic count before the provider is asked.
  it("signin_code: twelve parallel reservations, five get through; giving one back lets one more in", async () => {
    const mine = who("198.51.100.30", "race@x.test");
    const results = await Promise.all(
      Array.from({ length: 12 }, () => enforceAuthLimit(run, KEY, clock, "signin_code", mine)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect((await peekAuthLimit(run, KEY, clock, "signin_code", mine)).allowed).toBe(false);

    expect(await releaseAuthLimit(run, KEY, clock.now(), "signin_code", mine)).toBe(true);
    expect((await peekAuthLimit(run, KEY, clock, "signin_code", mine)).allowed).toBe(true);
    expect((await enforceAuthLimit(run, KEY, clock, "signin_code", mine)).allowed).toBe(true);
    expect((await enforceAuthLimit(run, KEY, clock, "signin_code", mine)).allowed).toBe(false);
    // A release that cannot be made says so and changes nothing.
    expect(
      await releaseAuthLimit(run, KEY, clock.now(), "signin_code", { ...mine, ip: "nope" }),
    ).toBe(false);
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
