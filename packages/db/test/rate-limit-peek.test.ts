import { expect, it } from "vitest";
import type { Tx } from "../client";
import { consumeRateLimits, peekRateLimits, type LimitRule } from "../repositories/rate-limit";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";

// WPU-X11 round 2: the sign-in counts only the authenticator codes that failed after a correct
// password, so it must ask "is this caller already at the limit" without adding a hit. peekRateLimits
// reads the counters that consumeRateLimits writes and never changes one.

const t = useTempDatabase();
const asWeb = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });
const NOW = new Date("2026-11-14T10:00:00.000Z");
const hex = (c: string) => c.repeat(32);
const rule = (over: Partial<LimitRule> = {}): LimitRule => ({
  kind: "email",
  subject: hex("b"),
  action: "auth.signin_code",
  limit: 2,
  windowSeconds: 900,
  ...over,
});
const countOf = async () =>
  (await t.pool.query("select coalesce(sum(count), 0)::int as n from rate_limits")).rows[0].n;

it("allows while the count is under the limit and refuses at it, without ever adding a hit", async () => {
  expect(await asWeb((tx) => peekRateLimits(tx, [rule()], NOW))).toEqual({ allowed: true });
  expect(await countOf()).toBe(0);

  await asWeb((tx) => consumeRateLimits(tx, [rule()], NOW));
  expect(await asWeb((tx) => peekRateLimits(tx, [rule()], NOW))).toEqual({ allowed: true });
  await asWeb((tx) => consumeRateLimits(tx, [rule()], NOW));

  // Two hits of two: full. A peek, however often, leaves the count at two.
  for (let i = 0; i < 3; i++) {
    expect(await asWeb((tx) => peekRateLimits(tx, [rule()], NOW))).toEqual({
      allowed: false,
      action: "auth.signin_code",
      retryAfterSeconds: 900,
    });
  }
  expect(await countOf()).toBe(2);
});

it("a new window is empty again, and the answer names the rule that refused", async () => {
  const day = rule({ limit: 1, windowSeconds: 86_400 });
  await asWeb((tx) => consumeRateLimits(tx, [rule({ limit: 5 }), day], NOW));
  const later = new Date(NOW.getTime() + 20 * 60_000);
  // The 15 minute window of NOW is over; the day window still holds the hit.
  expect(await asWeb((tx) => peekRateLimits(tx, [rule({ limit: 5 }), day], later))).toMatchObject({
    allowed: false,
    action: "auth.signin_code",
  });
  const next = new Date(NOW.getTime() + 25 * 3_600_000);
  expect(await asWeb((tx) => peekRateLimits(tx, [day], next))).toEqual({ allowed: true });
});

it("is per subject and per action, and takes the same rules as consume (R16: bad input throws)", async () => {
  await asWeb((tx) => consumeRateLimits(tx, [rule({ limit: 1 })], NOW));
  expect(
    await asWeb((tx) => peekRateLimits(tx, [rule({ limit: 1, subject: hex("c") })], NOW)),
  ).toEqual({
    allowed: true,
  });
  expect(
    await asWeb((tx) => peekRateLimits(tx, [rule({ limit: 1, action: "auth.other" })], NOW)),
  ).toEqual({
    allowed: true,
  });
  await expect(asWeb((tx) => peekRateLimits(tx, [], NOW))).rejects.toThrow(TypeError);
  await expect(
    asWeb((tx) => peekRateLimits(tx, [rule({ subject: "rahim@example.com" })], NOW)),
  ).rejects.toThrow(TypeError);
  await expect(asWeb((tx) => peekRateLimits(tx, [rule({ limit: 0 })], NOW))).rejects.toThrow(
    TypeError,
  );
});
