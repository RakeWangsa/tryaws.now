import {
  completeSignIn,
  currentCustomer,
  registerAccount,
  requireCustomer,
  signInDepsFor,
} from "@tc/auth";
import type { AuthRuntimeLike, CustomerSession, SignedIn } from "@tc/auth";
import type { Clock } from "@tc/core";
import { LAUNCH_MARKET, customerRepos, readMarketSettingNumber, withTx } from "@tc/db";
import {
  OTP_DAILY_CAP_SETTING,
  emailSubject,
  notify,
  otpSendRules,
  sendPhoneOtp,
  verifyPhoneOtp,
} from "@tc/notify";
import type { SendOtpDeps } from "@tc/notify";
import { enforceAuthLimit, peekAuthLimit, releaseAuthLimit } from "./auth/limits.ts";
import { clearTotpDrift } from "./totp-drift.ts";
import type { AuthPorts } from "./auth/ports.ts";
import { proxyAuthRuntime } from "./proxy-auth.ts";
import type { WebRuntime } from "./runtime.ts";

// The production implementation of AuthPorts: the session from @tc/auth, the limiter and the audit
// rows through withTx as role web_rw, the OTP service from @tc/notify. Nothing here is reached by a
// unit test of a core; the cores get fakes. R8: the customer id is always the one of the verified
// session, and the only code that turns a Cognito sub into a customer id is packages/auth.

const DENIED_UNAVAILABLE: SignedIn = {
  ok: false,
  error: "upstream_unavailable",
  reason: "unavailable",
};

async function authRuntime(): Promise<AuthRuntimeLike | null> {
  return proxyAuthRuntime(process.env);
}

export function productionPorts(runtime: WebRuntime, clock: Clock): AuthPorts {
  return {
    async currentSession() {
      const found = await currentCustomer();
      return found.ok ? found.value : null;
    },

    async requireSession() {
      try {
        return { ok: true, session: await requireCustomer() };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return {
          ok: false,
          reason: code === "upstream_unavailable" ? "unavailable" : "unauthenticated",
        };
      }
    },

    limit: (action, who, key) => enforceAuthLimit(withTx, key, clock, action, who),

    limitPeek: (action, who, key) => peekAuthLimit(withTx, key, clock, action, who),

    limitRelease: (action, who, key, at) => releaseAuthLimit(withTx, key, at, action, who),

    async noticeTotpBlocked({ email, ip, key }) {
      // The sign-in knows the address that typed the right password, not the customer: an email only.
      // One notice per address and quarter hour (R7: the dedupe key is unique); no more than that.
      const subject = emailSubject(key, email);
      if (subject === null) return;
      const at = clock.now();
      await withTx((tx) =>
        notify(tx, {
          email,
          template: "security_totp_blocked",
          data: { at: at.toISOString(), ip },
          dedupeKey: `totp-blocked:${subject}:${Math.floor(at.getTime() / 900_000)}`,
        }),
      );
    },

    register: (input) => {
      const { password, ...customer } = input;
      return registerAccount(
        { idp: runtime.identity as NonNullable<WebRuntime["identity"]>, run: withTx },
        { ...customer, market: LAUNCH_MARKET.code, password },
      );
    },

    async completeSignIn(tokens) {
      const rt = await authRuntime();
      if (rt === null) return DENIED_UNAVAILABLE;
      return completeSignIn(signInDepsFor(rt), tokens);
    },

    async recordSignIn(session: CustomerSession, meta) {
      return withTx(async (tx) => {
        const repos = customerRepos(tx, session.customerId);
        const written = await repos.audit.record({
          action: "auth.sign_in",
          ip: meta.ip,
          ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
        });
        if (!written.ok) throw new Error("auth: the sign-in could not be audited");
        // WPU-X11: Cognito signs in confirmed addresses only, so a sign-in proves the e-mail. The first
        // time is kept; without the row nothing is set and the sign-in is refused (R16).
        const marked = await repos.profile.markEmailVerified(new Date());
        if (!marked.ok) throw new Error("auth: no customer row");
        const profile = marked.value;
        // WPU-X11 round 2: the platform says the authenticator is on, but these tokens came without the
        // challenge. It was switched off outside the panel (own token on the public endpoint, a stolen
        // token, support). Clear the copy, audit it, tell the customer; a refused write fails the
        // sign-in (R16). The reverse (challenge answered, copy off) is the safe leftover and is left.
        if (profile.totpEnabledAt !== null && meta.totpVerified !== true) {
          await clearTotpDrift(repos, {
            via: "sign_in",
            at: new Date(),
            notify: (at) =>
              notify(tx, {
                customerId: session.customerId,
                template: "security_totp_changed",
                data: { at: at.toISOString(), ip: meta.ip },
                dedupeKey: `totp-drift:${session.customerId}:${at.getTime()}`,
              }),
          });
        }
        return { phoneVerified: profile.phoneVerifiedAt !== null };
      });
    },

    async recordSignOut(session, meta) {
      await withTx(async (tx) => {
        const written = await customerRepos(tx, session.customerId).audit.record({
          action: "auth.sign_out",
          ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
          ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
        });
        if (!written.ok) throw new Error("auth: the sign-out could not be audited");
      });
    },

    async sendOtp(session, input) {
      const otp = runtime.otp;
      if (otp === null) return { ok: false, error: "upstream_unavailable" };
      // The daily cap of the customer is a market setting (WPU-B6), read per request; a missing or bad
      // row is the default. The text of the SMS is the gateway's fixed format (WPU-Z3): no market digits.
      const dailyCap = await withTx(async (tx) => {
        const profile = await customerRepos(tx, session.customerId).profile.get();
        return profile === null
          ? null
          : await readMarketSettingNumber(tx, profile.market, OTP_DAILY_CAP_SETTING);
      });
      // Named fields, no spread: the hashing key of the runtime is a getter that a spread drops.
      const deps: SendOtpDeps = {
        run: otp.run,
        clock: otp.clock,
        pepper: otp.pepper,
        sms: otp.sms,
        limits: otpSendRules(dailyCap),
      };
      return sendPhoneOtp(deps, session, input);
    },

    async verifyOtp(session, input) {
      const otp = runtime.otp;
      if (otp === null) return { ok: false, error: "upstream_unavailable" };
      return verifyPhoneOtp({ run: otp.run, clock: otp.clock, pepper: otp.pepper }, session, input);
    },
  };
}
