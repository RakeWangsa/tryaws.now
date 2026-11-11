import type { Locale } from "@tc/core";
import type { Tx } from "@tc/db";
import { newCustomer, runTransaction, type TempDatabaseHandle } from "@tc/db/testing";
import type { SendOtpDeps } from "../otp/deps";
import { OTP_SEND_RULES } from "../otp/policy";
import { InMemorySmsProvider } from "../sms/fake";
import { fixedClock, PEPPER } from "./harness";

// The setup that every service test file shares, so that no file copies it. The provider is built
// once per file; a test file calls reset() in beforeEach. Transactions run as web_rw, so the column
// grants of migration 0006 are exercised.
export function otpTestKit(t: TempDatabaseHandle) {
  const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    runTransaction(t.db, fn, { role: "web_rw" });
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
  const customer = async (locale: Locale = "bn") => ({
    customerId: await newCustomer(t.pool),
    locale,
  });
  const reset = (): void => {
    sms.reset();
    clock.set("2026-11-11T10:00:00.000Z");
  };
  return { run, clock, sms, deps, customer, reset };
}
