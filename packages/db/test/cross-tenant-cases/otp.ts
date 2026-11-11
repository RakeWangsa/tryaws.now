import { v7 as uuidv7 } from "uuid";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

const OTP_NOW = new Date("2026-11-11T10:00:00.000Z");

export const otpCases: CaseSet = defineCaseSet<{ customerId: string; otpChallengeId: string }>({
  repo: "otp",
  seed: async (pool, customerId) => ({
    customerId,
    otpChallengeId: await insertRow(pool, "otp_challenges", {
      customer_id: customerId,
      phone: "+8801712345678",
      code_hash: "v1." + "0".repeat(64),
      expires_at: new Date(OTP_NOW.getTime() + 300_000),
    }),
  }),
  cases: ({ asCustomer }) => ({
    "otp.issue": {
      kind: "self-write",
      run: (c) =>
        asCustomer(c, (r) =>
          r.otp.issue({
            id: uuidv7(),
            phone: "+8801812345678",
            codeHash: "v1." + "1".repeat(64),
            expiresAt: new Date(OTP_NOW.getTime() + 300_000),
            now: OTP_NOW,
          }),
        ),
    },
    "otp.claimAttempt": {
      kind: "self-write",
      run: (c) =>
        asCustomer(c, (r) =>
          r.otp.claimAttempt({
            now: OTP_NOW,
            latestExpiry: new Date(OTP_NOW.getTime() + 360_000),
            maxAttempts: 5,
          }),
        ),
    },
    "otp.close": {
      kind: "write",
      run: (c, s) => asCustomer(c, (r) => r.otp.close(s.otpChallengeId, OTP_NOW)),
    },
    "otp.latest": { kind: "read", run: (c) => asCustomer(c, (r) => r.otp.latest()) },
  }),
});
