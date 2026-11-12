import { randomUUID } from "node:crypto";
import type { Tx } from "@tc/db";
import { newCustomer, runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeEach, expect, it } from "vitest";
import { OTP_DAILY_CAP_DEFAULT, OTP_SEND_RULES, otpSendRules } from "../otp/policy";
import { sendPhoneOtp } from "../otp/send";
import { InMemorySmsProvider } from "../sms/fake";
import { PEPPER, fixedClock, freshIp, freshPhone } from "./harness";

// WPU-B6, item 29: the daily cap of OTP SMS for one customer, whatever the number and the network.
const t = useTempDatabase();
const run = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });
const clock = fixedClock();
const sms = new InMemorySmsProvider();

beforeEach(() => {
  sms.reset();
  clock.set("2026-11-11T10:00:00.000Z");
});

it("otpSendRules adds one customer rule of 24 hours; a bad cap is the default of 10 (R16)", () => {
  const customerRule = (cap: number | null | undefined) =>
    otpSendRules(cap).find((r) => r.kind === "customer");
  expect(otpSendRules(undefined)).toHaveLength(OTP_SEND_RULES.length + 1);
  expect(customerRule(null)).toMatchObject({ limit: OTP_DAILY_CAP_DEFAULT, windowSeconds: 86_400 });
  expect(customerRule(3)).toMatchObject({ limit: 3 });
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    expect(customerRule(bad)?.limit).toBe(OTP_DAILY_CAP_DEFAULT);
  }
  expect(customerRule(1e9)?.limit).toBeLessThanOrEqual(OTP_DAILY_CAP_DEFAULT * 10);
});

it("the 4th send in a day is refused for a cap of 3, on other numbers and networks too", async () => {
  const session = { customerId: await newCustomer(t.pool), locale: "bn" as const };
  const deps = { run, sms, clock, pepper: PEPPER, limits: otpSendRules(3) };
  const send = (s: typeof session) =>
    sendPhoneOtp(deps, s, { phone: freshPhone(), ip: freshIp(), idempotencyKey: randomUUID() });
  for (let i = 0; i < 3; i++) {
    expect((await send(session)).ok).toBe(true);
    clock.advanceSeconds(3700);
  }
  expect(await send(session)).toMatchObject({ ok: false, error: "rate_limited" });
  expect(sms.sent).toHaveLength(3);
  // Another customer is not affected.
  const other = { customerId: await newCustomer(t.pool), locale: "bn" as const };
  expect((await send(other)).ok).toBe(true);
});
