import {
  completeSignIn,
  currentCustomer,
  registerAccount,
  requireCustomer,
  signInDepsFor,
} from "@tc/auth";
import type { AuthRuntimeLike, CustomerSession, SignedIn } from "@tc/auth";
import type { Clock } from "@tc/core";
import {
  LAUNCH_MARKET,
  customerRepos,
  readMarketBasics,
  readMarketSettingNumber,
  withTx,
} from "@tc/db";
import { OTP_DAILY_CAP_SETTING, otpSendRules, sendPhoneOtp, verifyPhoneOtp } from "@tc/notify";
import type { Numerals, SendOtpDeps } from "@tc/notify";
import { enforceAuthLimit } from "./auth/limits.ts";
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
        const profile = await repos.profile.get();
        if (profile === null) throw new Error("auth: no customer row");
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
      // The digits of the SMS are the market's setting, read per request, not at start-up.
      // The daily cap of the customer is a market setting too (WPU-B6); a missing or bad row is the default.
      const { numerals, dailyCap } = await withTx(async (tx) => {
        const profile = await customerRepos(tx, session.customerId).profile.get();
        const market = profile === null ? null : await readMarketBasics(tx, profile.market);
        const cap =
          profile === null
            ? null
            : await readMarketSettingNumber(tx, profile.market, OTP_DAILY_CAP_SETTING);
        return { numerals: (market?.numerals ?? "beng") as Numerals, dailyCap: cap };
      });
      const deps: SendOtpDeps = { ...otp, numerals, limits: otpSendRules(dailyCap) };
      return sendPhoneOtp(deps, session, input);
    },

    async verifyOtp(session, input) {
      const otp = runtime.otp;
      if (otp === null) return { ok: false, error: "upstream_unavailable" };
      return verifyPhoneOtp({ run: otp.run, clock: otp.clock, pepper: otp.pepper }, session, input);
    },
  };
}
