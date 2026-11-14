import { expect, it } from "vitest";
import type { Tx } from "../client";
import {
  consumeRateLimits,
  peekRateLimits,
  releaseRateLimits,
  type LimitRule,
} from "../repositories/rate-limit";
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

// WPU-X11 round 2 (review: check-then-count is racy). The sign-in reserves its attempt with consume BEFORE it
// calls the provider (the conditional upsert is atomic, so N parallel guesses never get past the limit) and
// gives the hit back with releaseRateLimits when the attempt turns out not to be a wrong code. The database
// is shared by the tests of this file, so each of these uses subjects of its own.
const countFor = async (subject: string) =>
  (
    await t.pool.query(
      "select coalesce(sum(count), 0)::int as n from rate_limits where scope_key like $1",
      [`%${subject}%`],
    )
  ).rows[0].n as number;

it("releaseRateLimits gives one hit back, never goes below zero, and leaves other subjects and windows alone", async () => {
  const mine = rule({ limit: 3, subject: hex("d") });
  const other = rule({ limit: 3, subject: hex("e") });
  await asWeb((tx) => consumeRateLimits(tx, [mine, other], NOW));
  await asWeb((tx) => consumeRateLimits(tx, [mine], NOW));
  expect(await countFor(mine.subject)).toBe(2);

  await asWeb((tx) => releaseRateLimits(tx, [mine], NOW));
  expect(await countFor(mine.subject)).toBe(1);
  expect(await countFor(other.subject)).toBe(1);

  // Released more often than reserved: it stops at zero.
  for (let i = 0; i < 3; i++) await asWeb((tx) => releaseRateLimits(tx, [mine], NOW));
  expect(await countFor(mine.subject)).toBe(0);
  expect(await countFor(other.subject)).toBe(1);

  // A release for a window that has no row changes nothing and does not throw.
  const later = new Date(NOW.getTime() + 3_600_000);
  await asWeb((tx) => releaseRateLimits(tx, [mine], later));
  expect(await countFor(mine.subject)).toBe(0);
});

it("releaseRateLimits gives back only the wrong-code reservation: any other action is a TypeError and changes nothing", async () => {
  const other = rule({ action: "auth.signin", subject: hex("1"), limit: 5 });
  await asWeb((tx) => consumeRateLimits(tx, [other], NOW));
  for (const action of ["auth.signin", "otp.send", "auth.signup", "order.place", "wallet.topup"]) {
    await expect(
      asWeb((tx) => releaseRateLimits(tx, [rule({ action, subject: hex("1") })], NOW)),
    ).rejects.toThrow(TypeError);
  }
  // One bad rule among good ones refuses the whole call, before any row is touched.
  const good = rule({ subject: hex("2"), limit: 5 });
  await asWeb((tx) => consumeRateLimits(tx, [good], NOW));
  await expect(
    asWeb((tx) =>
      releaseRateLimits(tx, [good, rule({ action: "auth.signin", subject: hex("2") })], NOW),
    ),
  ).rejects.toThrow(TypeError);
  expect(await countFor(hex("1"))).toBe(1);
  expect(await countFor(hex("2"))).toBe(1);
});

it("releaseRateLimits takes the same rules as consume (R16: bad input throws)", async () => {
  await expect(asWeb((tx) => releaseRateLimits(tx, [], NOW))).rejects.toThrow(TypeError);
  await expect(
    asWeb((tx) => releaseRateLimits(tx, [rule({ subject: "rahim@example.com" })], NOW)),
  ).rejects.toThrow(TypeError);
  await expect(asWeb((tx) => releaseRateLimits(tx, [rule({ limit: 0 })], NOW))).rejects.toThrow(
    TypeError,
  );
});

it("parallel reservations never pass the limit: twelve at once, two get through", async () => {
  const two = rule({ limit: 2, subject: hex("f") });
  const results = await Promise.all(
    Array.from({ length: 12 }, () => asWeb((tx) => consumeRateLimits(tx, [two], NOW))),
  );
  expect(results.filter((r) => r.allowed)).toHaveLength(2);
  expect(await countFor(two.subject)).toBe(2);
});
