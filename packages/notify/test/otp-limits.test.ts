import { randomUUID } from "node:crypto";
import { normalizeBdMobile } from "@tc/core";
import { limitKey, type Tx } from "@tc/db";
import { newCustomer, runTransaction, tenantSnapshot, useTempDatabase } from "@tc/db/testing";
import { beforeEach, expect, it } from "vitest";
import type { SendOtpDeps } from "../otp/deps";
import { OTP_SEND_RULES, type SendRule } from "../otp/policy";
import { sendPhoneOtp, type SendPhoneOtpInput } from "../otp/send";
import { verifyPhoneOtp } from "../otp/verify";
import { InMemorySmsProvider } from "../sms/fake";
import { PEPPER, fixedClock, freshIp, freshPhone, lastCode } from "./harness";

// The proof of WP2-T3: "Limits hold: 5 attempts, 3 sends per hour per number and per IP; codes are stored hashed."
const t = useTempDatabase();
const run = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });
const clock = fixedClock();
const sms = new InMemorySmsProvider();
const deps = (over: Partial<SendOtpDeps> = {}): SendOtpDeps => ({
  run,
  sms,
  clock,
  pepper: PEPPER,
  limits: OTP_SEND_RULES,
  ...over,
});
const customer = async () => ({ customerId: await newCustomer(t.pool), locale: "bn" as const });
const send = (
  s: Awaited<ReturnType<typeof customer>>,
  over: Partial<SendPhoneOtpInput> = {},
  d: SendOtpDeps = deps(),
) =>
  sendPhoneOtp(d, s, { phone: freshPhone(), ip: freshIp(), idempotencyKey: randomUUID(), ...over });
const limited = (retryAfterSeconds: number) => ({
  ok: false,
  error: "rate_limited",
  data: { retryAfterSeconds },
});
beforeEach(() => {
  sms.reset();
  clock.set("2026-11-11T10:00:00.000Z");
});

it("3 sends an hour per number: the fourth is refused, and the next hour allows it again", async () => {
  const s = await customer();
  const phone = freshPhone();
  for (let i = 0; i < 3; i++) {
    expect((await send(s, { phone })).ok).toBe(true);
    clock.advanceSeconds(60);
  }
  expect(await send(s, { phone })).toEqual(limited(3420)); // 10:03:00, the window ends at 11:00:00
  clock.set("2026-11-11T10:59:59.999Z");
  expect(await send(s, { phone })).toEqual(limited(1));
  clock.set("2026-11-11T11:00:00.000Z");
  expect((await send(s, { phone })).ok).toBe(true);
  expect(sms.sent).toHaveLength(4);
});

it("the same number in four formats is one number: the fourth format is refused", async () => {
  const s = await customer();
  for (const phone of ["01712340001", "+8801712340001", "০১৭১২৩৪০০০১"]) {
    expect((await send(s, { phone })).ok).toBe(true);
    clock.advanceSeconds(60);
  }
  expect(await send(s, { phone: "8801712340001" })).toEqual(limited(3420));
  expect(new Set(sms.sent.map((m) => m.to))).toEqual(new Set(["+8801712340001"]));
});

it("3 sends an hour per IP: the fourth number from one address is refused; its mapped form and one /64 share the quota", async () => {
  const s = await customer();
  const ip = freshIp();
  for (let i = 0; i < 3; i++) expect((await send(s, { ip })).ok).toBe(true); // three different numbers
  expect(await send(s, { ip })).toEqual(limited(3600));
  expect(await send(s, { ip: "::ffff:" + ip })).toEqual(limited(3600));
  expect((await send(s, { ip: freshIp() })).ok).toBe(true); // another address, another quota
  for (const host of ["2001:db8:abcd:12::1", "2001:db8:abcd:12::2", "2001:db8:abcd:12:ffff::3"]) {
    expect((await send(s, { ip: host })).ok).toBe(true);
  }
  expect(await send(s, { ip: "2001:db8:abcd:12::4" })).toEqual(limited(3600));
  expect((await send(s, { ip: "2001:db8:abcd:13::1" })).ok).toBe(true);
});

it("the resend pace: a second send to a number in the same minute is refused with the seconds left", async () => {
  const s = await customer();
  const phone = freshPhone();
  expect((await send(s, { phone })).ok).toBe(true);
  clock.advanceSeconds(30);
  expect(await send(s, { phone })).toEqual(limited(30));
  clock.advanceSeconds(30);
  expect((await send(s, { phone })).ok).toBe(true);
});

const OPTION_A: readonly SendRule[] = [
  { kind: "phone", action: "otp.send", limit: 3, windowSeconds: 3600 },
  { kind: "customer", action: "otp.send", limit: 10, windowSeconds: 86400 },
  { kind: "ip", action: "otp.send", limit: 30, windowSeconds: 3600 },
  { kind: "phone", action: "otp.resend", limit: 1, windowSeconds: 60 },
];
it("option (a) of decision 31 (3 an hour per number, 10 a day per customer, 30 an hour per IP) is only another rule list", async () => {
  const s = await customer();
  const d = deps({ limits: OPTION_A });
  const ip = freshIp();
  for (let i = 0; i < 10; i++) expect((await send(s, { ip }, d)).ok).toBe(true);
  expect(await send(s, { ip }, d)).toEqual(limited(50400)); // until 00:00 UTC, 14 hours from 10:00
  const rows = (await tenantSnapshot(t.pool, s.customerId)).rate_limits!.map((row) =>
    JSON.parse(row),
  );
  expect(rows.map((r) => [r.scope_key, r.count])).toEqual([
    [limitKey("customer", s.customerId, "otp.send", 86400), 10],
  ]);
  expect((await send(await customer(), { ip }, d)).ok).toBe(true); // another customer is not held back by this one's day
});

it("5 attempts: five wrong codes, then the right code is refused; a new code starts again", async () => {
  const s = await customer();
  const phone = freshPhone();
  const to = normalizeBdMobile(phone)!;
  await send(s, { phone });
  const code = lastCode(sms, to);
  const wrong = code === "999999" ? "999998" : "999999";
  for (let i = 0; i < 5; i++) {
    expect(await verifyPhoneOtp(deps(), s, { code: wrong })).toMatchObject({
      ok: false,
      error: "validation",
    });
  }
  expect(await verifyPhoneOtp(deps(), s, { code })).toEqual({ ok: false, error: "limit_reached" });
  expect(
    (
      await t.pool.query("select attempts from otp_challenges where customer_id = $1", [
        s.customerId,
      ])
    ).rows,
  ).toEqual([{ attempts: 5 }]);
  expect(
    (await t.pool.query("select phone_verified_at from customers where id = $1", [s.customerId]))
      .rows[0].phone_verified_at,
  ).toBeNull();
  clock.advanceSeconds(60);
  await send(s, { phone });
  expect((await verifyPhoneOtp(deps(), s, { code: lastCode(sms, to) })).ok).toBe(true);
});

it("codes are stored hashed: the code is found in no row of any table, and the limit keys hold no number and no address", async () => {
  const s = await customer();
  const phone = freshPhone();
  const to = normalizeBdMobile(phone)!;
  const ip = "203.0.113.77";
  await send(s, { phone, ip }, deps({ randomInt: () => 481516 }));
  const code = lastCode(sms, to);
  expect(code).toBe("481516");
  // every row of every base table of schema public, as text (also jsonb columns such as notifications.payload and audit_log.metadata);
  // a six-digit run inside a longer digit run or a word is not the code. A random timestamp can hold the same six digits between
  // two non-alphanumeric characters: about 1 in 1,000,000 per timestamp, accepted.
  const tables = (
    await t.pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    )
  ).rows.map((r) => r.table_name as string);
  const hit = new RegExp(`(^|[^0-9A-Za-z])${code}([^0-9A-Za-z]|$)`);
  for (const table of tables) {
    const rows = (await t.pool.query(`select to_jsonb(x)::text as row from "${table}" x`)).rows.map(
      (r) => r.row as string,
    );
    expect(
      rows.filter((row) => hit.test(row)),
      table,
    ).toEqual([]);
  }
  const [row] = (
    await t.pool.query("select code_hash from otp_challenges where customer_id = $1", [
      s.customerId,
    ])
  ).rows;
  expect(row.code_hash).toMatch(/^v1\.[0-9a-f]{64}$/);
  for (const { scope_key } of (await t.pool.query("select scope_key from rate_limits")).rows) {
    expect(scope_key).not.toContain(to.slice(4));
    expect(scope_key).not.toContain(ip);
  }
  expect((await t.pool.query("select count(*)::int as n from notifications")).rows[0].n).toBe(0); // the code never went through the outbox
});
