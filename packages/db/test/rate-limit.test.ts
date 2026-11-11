import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import {
  consumeRateLimits,
  limitKey,
  windowStartOf,
  type LimitRule,
} from "../repositories/rate-limit";
import { waitForLockWait } from "../testing/lock-wait";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const asWeb = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });
const at = (iso: string) => new Date(iso);
const NOW = at("2026-11-11T10:00:00.000Z");
const hex = (c: string) => c.repeat(32);
const rule = (over: Partial<LimitRule> = {}): LimitRule => ({
  kind: "phone",
  subject: hex("a"),
  action: "otp.send",
  limit: 3,
  windowSeconds: 3600,
  ...over,
});
const rowsOf = async (key: string) =>
  (
    await t.pool.query(
      "select window_start, count from rate_limits where scope_key = $1 order by window_start",
      [key],
    )
  ).rows;

it("limitKey builds the key and refuses anything outside the format", () => {
  expect(limitKey("phone", hex("a"), "otp.send", 3600)).toBe(`phone:${hex("a")}:otp.send:3600`);
  expect(limitKey("ip", hex("0"), "otp.resend", 60)).toBe(`ip:${hex("0")}:otp.resend:60`);
  expect(limitKey("customer", "01A1C989-A7AA-7337-AAF6-40387049A15D", "topup.start", 86400)).toBe(
    "customer:01a1c989-a7aa-7337-aaf6-40387049a15d:topup.start:86400",
  );
  for (const bad of [
    () => limitKey("phone", "abc", "otp.send", 3600),
    () => limitKey("phone", hex("A"), "otp.send", 3600),
    () => limitKey("phone", hex("a"), "Otp.send", 3600),
    () => limitKey("phone", hex("a"), "otp:send", 3600),
    () => limitKey("phone", hex("a"), "", 3600),
    () => limitKey("phone", hex("a"), "otp.send", 0),
    () => limitKey("phone", hex("a"), "otp.send", 86401),
    () => limitKey("phone", hex("a"), "otp.send", 1.5),
    () => limitKey("customer", "not-a-uuid", "x", 60),
    () => limitKey("foo" as never, hex("a"), "x", 60),
    () => limitKey("email", "rahim@example.com", "signin", 900),
    () => limitKey("email", hex("A"), "signin", 900),
  ])
    expect(bad).toThrow(TypeError);
});

it("limitKey builds the email key like the ip and phone keys", () => {
  expect(limitKey("email", hex("9"), "signup", 3600)).toBe(`email:${hex("9")}:signup:3600`);
});

it("an email rule counts: allowed, allowed, refused with the seconds left in the window", async () => {
  const r = rule({ kind: "email", subject: hex("1"), action: "forgot", limit: 2 });
  expect(await asWeb((tx) => consumeRateLimits(tx, [r], NOW))).toEqual({ allowed: true });
  expect(await asWeb((tx) => consumeRateLimits(tx, [r], NOW))).toEqual({ allowed: true });
  const refused = await asWeb((tx) => consumeRateLimits(tx, [r], NOW));
  expect(refused).toEqual({ allowed: false, action: "forgot", retryAfterSeconds: 3600 });
  expect(await rowsOf(limitKey("email", hex("1"), "forgot", 3600))).toEqual([
    { window_start: NOW, count: 2 },
  ]);
});

it("an ip, an email and a phone rule with one subject and one action keep three counters", async () => {
  const subject = hex("2");
  for (const kind of ["ip", "email", "phone"] as const) {
    await asWeb((tx) => consumeRateLimits(tx, [rule({ kind, subject, limit: 1 })], NOW));
  }
  for (const kind of ["ip", "email", "phone"] as const) {
    expect(await rowsOf(limitKey(kind, subject, "otp.send", 3600))).toEqual([
      { window_start: NOW, count: 1 },
    ]);
  }
});

it("two rules in one call apply in ascending key order and the first refusal stops the call", async () => {
  const email = rule({ kind: "email", subject: hex("3"), action: "x", limit: 1 });
  const ip = rule({ kind: "ip", subject: hex("4"), action: "x", limit: 5 });
  await asWeb((tx) => consumeRateLimits(tx, [email], NOW)); // the email is at its limit
  // "email:" sorts before "ip:", so the email refuses and the ip is never touched
  expect(await asWeb((tx) => consumeRateLimits(tx, [ip, email], NOW))).toEqual({
    allowed: false,
    action: "x",
    retryAfterSeconds: 3600,
  });
  expect(await rowsOf(limitKey("ip", hex("4"), "x", 3600))).toEqual([]);
});

it("an email rule with a subject that is not 32 lower-case hex is a TypeError", async () => {
  for (const subject of ["rahim@example.com", hex("A"), "abc"]) {
    await expect(
      asWeb((tx) => consumeRateLimits(tx, [rule({ kind: "email", subject })], NOW)),
    ).rejects.toThrow(TypeError);
  }
});

it("the refusal of an unknown kind says only ip, phone and email are accepted", async () => {
  for (const kind of ["customer", "foo"]) {
    await expect(
      asWeb((tx) => consumeRateLimits(tx, [rule({ kind: kind as never })], NOW)),
    ).rejects.toThrow("rate limit: only ip, phone and email rules are accepted");
  }
});

it("web_rw keeps the grants it had on rate_limits: no new column, no migration", () => {
  const grants = JSON.parse(
    readFileSync(new URL("./grants.expected.json", import.meta.url), "utf8"),
  ) as Record<string, Record<string, { insertColumns: string[] | null }>>;
  expect(grants["rate_limits"]!["web_rw"]!.insertColumns).toEqual([
    "id",
    "scope_key",
    "window_start",
    "count",
  ]);
});

it.each([
  ["2026-11-11T10:59:59.999Z", 3600, "2026-11-11T10:00:00.000Z"],
  ["2026-11-11T11:00:00.000Z", 3600, "2026-11-11T11:00:00.000Z"],
  ["2026-11-11T10:00:30.500Z", 60, "2026-11-11T10:00:00.000Z"],
  ["2026-11-11T23:59:59.999Z", 86400, "2026-11-11T00:00:00.000Z"],
])("windowStartOf(%s, %i) is %s", (now, seconds, start) => {
  expect(windowStartOf(at(now), seconds).toISOString()).toBe(start);
});

it("allows three, refuses the fourth with the seconds left, and a refused call changes nothing", async () => {
  const r = rule({ subject: hex("b") });
  for (const now of [
    "2026-11-11T10:00:00.000Z",
    "2026-11-11T10:30:00.000Z",
    "2026-11-11T10:45:00.000Z",
  ]) {
    expect(await asWeb((tx) => consumeRateLimits(tx, [r], at(now)))).toEqual({ allowed: true });
  }
  expect(await asWeb((tx) => consumeRateLimits(tx, [r], at("2026-11-11T10:45:00.000Z")))).toEqual({
    allowed: false,
    action: "otp.send",
    retryAfterSeconds: 900,
  });
  expect(await asWeb((tx) => consumeRateLimits(tx, [r], at("2026-11-11T10:59:59.999Z")))).toEqual({
    allowed: false,
    action: "otp.send",
    retryAfterSeconds: 1,
  });
  expect(await rowsOf(limitKey("phone", hex("b"), "otp.send", 3600))).toEqual([
    { window_start: NOW, count: 3 },
  ]);
});

it("the next window starts at the hour: allowed at 11:00:00.000, and the old row keeps its count", async () => {
  const r = rule({ subject: hex("c"), limit: 1 });
  expect(await asWeb((tx) => consumeRateLimits(tx, [r], at("2026-11-11T10:59:59.999Z")))).toEqual({
    allowed: true,
  });
  expect(await asWeb((tx) => consumeRateLimits(tx, [r], at("2026-11-11T11:00:00.000Z")))).toEqual({
    allowed: true,
  });
  expect(await rowsOf(limitKey("phone", hex("c"), "otp.send", 3600))).toEqual([
    { window_start: NOW, count: 1 },
    { window_start: at("2026-11-11T11:00:00.000Z"), count: 1 },
  ]);
});

it("rules apply in key order (ip before phone), and a throw after a refusal rolls back the earlier increments", async () => {
  const ip = rule({ kind: "ip", subject: hex("d") });
  const phone = rule({ subject: hex("e"), limit: 1 });
  await asWeb((tx) => consumeRateLimits(tx, [phone], NOW)); // the phone is at its limit
  await expect(
    asWeb(async (tx) => {
      const d = await consumeRateLimits(tx, [phone, ip], NOW);
      if (!d.allowed) throw new Error("refused");
    }),
  ).rejects.toThrow("refused");
  expect(await rowsOf(limitKey("ip", hex("d"), "otp.send", 3600))).toEqual([]);
  expect(await rowsOf(limitKey("phone", hex("e"), "otp.send", 3600))).toEqual([
    { window_start: NOW, count: 1 },
  ]);
});

it("an empty list, a customer rule and an invalid field are refused before any statement", async () => {
  await expect(asWeb((tx) => consumeRateLimits(tx, [], NOW))).rejects.toThrow(TypeError);
  await expect(
    asWeb((tx) => consumeRateLimits(tx, [rule({ kind: "customer" as never })], NOW)),
  ).rejects.toThrow(TypeError);
  await expect(asWeb((tx) => consumeRateLimits(tx, [rule({ limit: 0 })], NOW))).rejects.toThrow(
    TypeError,
  );
  await expect(
    asWeb((tx) => consumeRateLimits(tx, [rule({ limit: 10_001 })], NOW)),
  ).rejects.toThrow(TypeError); // the upper bound of countHit
  await expect(
    asWeb((tx) => consumeRateLimits(tx, [rule({ subject: "+8801712345678" })], NOW)),
  ).rejects.toThrow(TypeError);
});

it("eight transactions at the same moment on one key: exactly three are allowed and the count is three", async () => {
  const r = rule({ subject: hex("f") });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => asWeb((tx) => consumeRateLimits(tx, [r], NOW))),
  );
  expect(results.filter((d) => d.allowed)).toHaveLength(3);
  expect(await rowsOf(limitKey("phone", hex("f"), "otp.send", 3600))).toEqual([
    { window_start: NOW, count: 3 },
  ]);
});

it("two connections at the same moment: the second waits for the first, then counts 2", async () => {
  const r = rule({ subject: hex("9") });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let counted!: () => void;
  const firstCounted = new Promise<void>((resolve) => (counted = resolve));
  const first = asWeb(async (tx) => {
    const d = await consumeRateLimits(tx, [r], NOW);
    counted();
    await gate; // the first transaction keeps its row lock until the gate opens
    return d;
  });
  await firstCounted;
  const second = asWeb((tx) => consumeRateLimits(tx, [r], NOW));
  await waitForLockWait(t.pool, t.name); // throws when the second statement never blocks
  expect(await rowsOf(limitKey("phone", hex("9"), "otp.send", 3600))).toEqual([]); // nothing committed yet
  release();
  expect(await first).toEqual({ allowed: true });
  expect(await second).toEqual({ allowed: true });
  expect(await rowsOf(limitKey("phone", hex("9"), "otp.send", 3600))).toEqual([
    { window_start: NOW, count: 2 },
  ]);
});

it("waitForLockWait fails by throwing when no statement waits for a lock", async () => {
  await expect(waitForLockWait(t.pool, t.name, { timeoutMs: 100 })).rejects.toThrow(
    "waitForLockWait: no statement waited for a lock in 100 ms",
  );
});
