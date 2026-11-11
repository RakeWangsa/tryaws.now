import type { Result } from "@tc/core";
import { maskPhone, parseOtpCode } from "@tc/core";
import { customerRepos } from "@tc/db";
import { assertPepper, codeMatches } from "./codes";
import type { OtpDeps } from "./deps";
import { OTP } from "./policy";

export interface VerifyPhoneOtpInput {
  readonly code: string;
}

export interface OtpVerified {
  readonly phoneMasked: string;
  readonly verifiedAt: Date;
}

// Fixed text: it never holds a code, a number or the key (R14).
const NOT_STORED = "otp: the verification could not be stored";

// Verifies the newest challenge of the customer. The attempt is claimed (counted) before the code
// is compared, and the count commits whatever the code is: the transaction returns a failed result
// and never throws for a wrong code, which is what makes the five attempts hold. Only a failed
// write of a right code throws, so that the transaction rolls back (R16).
export async function verifyPhoneOtp(
  deps: OtpDeps,
  session: { readonly customerId: string },
  input: VerifyPhoneOtpInput,
): Promise<Result<OtpVerified>> {
  assertPepper(deps.pepper);
  const code = parseOtpCode(input.code);
  if (code === null) return { ok: false, error: "validation", fields: { code: "malformed" } };

  return deps.run(async (tx): Promise<Result<OtpVerified>> => {
    const r = customerRepos(tx, session.customerId);
    const now = deps.clock.now();
    const latestExpiry = new Date(now.getTime() + (OTP.ttlSeconds + OTP.clockBehindSeconds) * 1000);
    const claim = await r.otp.claimAttempt({ now, latestExpiry, maxAttempts: OTP.maxAttempts });

    if (!claim.ok) {
      const latest = await r.otp.latest();
      const usable =
        latest !== null &&
        latest.consumedAt === null &&
        latest.expiresAt.getTime() > now.getTime() &&
        latest.expiresAt.getTime() <= latestExpiry.getTime();
      // An open challenge inside the window with attempts left means a newer send won the race:
      // the claim updated no row and nothing is counted.
      return usable && latest.attempts >= OTP.maxAttempts
        ? { ok: false, error: "limit_reached" }
        : { ok: false, error: "not_found" };
    }

    const claimed = claim.value;
    if (!codeMatches(deps.pepper, claimed.id, claimed.phone, code, claimed.codeHash)) {
      return {
        ok: false,
        error: "validation",
        fields: { code: "wrong" },
        data: { attemptsLeft: OTP.maxAttempts - claimed.attempts },
      };
    }

    const closed = await r.otp.close(claimed.id, now);
    const stored = closed.ok
      ? await r.profile.setVerifiedPhone({ phone: claimed.phone, verifiedAt: now })
      : closed;
    if (!stored.ok) throw new Error(NOT_STORED);
    return { ok: true, value: { phoneMasked: maskPhone(claimed.phone), verifiedAt: now } };
  });
}
