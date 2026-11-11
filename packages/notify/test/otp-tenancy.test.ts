import { randomUUID } from "node:crypto";
import { customerRepos, type Tx } from "@tc/db";
import { expectTenantIsolation, runTransaction, useTempDatabase } from "@tc/db/testing";
import { it } from "vitest";
import { hashCode } from "../otp/codes";
import type { SendOtpDeps } from "../otp/deps";
import { OTP_SEND_RULES } from "../otp/policy";
import { sendPhoneOtp } from "../otp/send";
import { verifyPhoneOtp } from "../otp/verify";
import { InMemorySmsProvider } from "../sms/fake";
import { PEPPER, fixedClock, freshIp, freshPhone } from "./harness";

const t = useTempDatabase();
const run = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });
const clock = fixedClock();
const deps = (): SendOtpDeps => ({
  run,
  sms: new InMemorySmsProvider(),
  clock,
  pepper: PEPPER,
  limits: OTP_SEND_RULES,
});
let next = 100000; // every customer gets its own code, so a code of customer A is a wrong code for customer B

it("sendPhoneOtp and verifyPhoneOtp are tenant-scoped (R8)", () =>
  expectTenantIsolation({
    pool: t.pool,
    seed: async (_pool, customerId) => {
      const id = randomUUID();
      const code = String(++next);
      const now = clock.now();
      await run((tx) =>
        customerRepos(tx, customerId).otp.issue({
          id,
          phone: "+8801712345678",
          codeHash: hashCode(PEPPER, id, "+8801712345678", code),
          expiresAt: new Date(now.getTime() + 300_000),
          now,
        }),
      );
      return { customerId, challengeId: id, code };
    },
    cases: [
      {
        name: "verifyPhoneOtp",
        kind: "write",
        run: async (customerId, s) => {
          const r = await verifyPhoneOtp(deps(), { customerId }, { code: s.code });
          return r.ok ? "verified" : r.error; // the attempts left differ between two calls, so the case compares the outcome only
        },
      },
      {
        name: "sendPhoneOtp",
        kind: "self-write",
        run: async (customerId) => {
          const r = await sendPhoneOtp(
            deps(),
            { customerId, locale: "bn" },
            { phone: freshPhone(), ip: freshIp(), idempotencyKey: randomUUID() },
          );
          return r.ok ? "sent" : r.error;
        },
      },
    ],
  }));
