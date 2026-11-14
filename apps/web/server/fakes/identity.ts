import { randomBytes, randomInt } from "node:crypto";
import type {
  IdentityProvider,
  IdpResult,
  RefreshPort,
  RefreshResult,
  SignInOutcome,
  SignUpOutcome,
} from "@tc/auth";
import type { Clock } from "@tc/core";
import type { Stage } from "../config.ts";
import { getFakeState } from "./outbox.ts";
import { acceptTotp } from "./totp.ts";

// Development and test only (open point 3): an in-memory identity provider for the Playwright smoke
// and the unit tests. It is the only implementation of IdentityProvider in memory. It issues the
// access token `dev.<sub>` that the dev verifier accepts, so the real session check, the real
// database and the real cookies are exercised. The constructor refuses outside stage local or test,
// without the fakes switch, or outside NODE_ENV development and test; the production runtime never
// imports this file (runtime.ts, a literal dynamic import behind the same guards).

const CODE_LIFETIME_MS = 30 * 60 * 1000;
const MIN_PASSWORD = 8;
const ok = <T>(value: T): IdpResult<T> => ({ ok: true, value });
const fail = (
  kind:
    | "invalid_code"
    | "expired_code"
    | "invalid_password"
    | "denied"
    | "code_denied"
    | "code_limited"
    | "not_confirmed"
    | "rate_limited"
    | "unavailable",
): IdpResult<never> => ({
  ok: false,
  kind,
});

export class InMemoryIdentityProvider implements IdentityProvider {
  private readonly clock: Clock;

  constructor(opts: { stage: Stage; fakes: boolean; clock?: Clock }) {
    const env = process.env.NODE_ENV;
    const placeOk = opts.stage === "local" || opts.stage === "test";
    if (!placeOk || opts.fakes !== true || (env !== "development" && env !== "test")) {
      throw new Error("InMemoryIdentityProvider is for tests and local runs only");
    }
    this.clock = opts.clock ?? { now: () => new Date() };
  }

  private issueCode(email: string, kind: "signup" | "reset"): void {
    const code = String(randomInt(1_000_000)).padStart(6, "0");
    getFakeState().emailCodes.set(email, { kind, code, issuedAtMs: this.clock.now().getTime() });
  }

  private checkCode(email: string, code: string, kind: "signup" | "reset"): IdpResult<true> {
    const entry = getFakeState().emailCodes.get(email);
    if (entry === undefined || entry.kind !== kind || entry.code !== code) {
      return fail("invalid_code");
    }
    if (this.clock.now().getTime() - entry.issuedAtMs > CODE_LIFETIME_MS) {
      return fail("expired_code");
    }
    return ok(true);
  }

  async signUp(i: {
    email: string;
    password: string;
    name: string;
    locale: "bn" | "en";
  }): Promise<IdpResult<SignUpOutcome>> {
    const state = getFakeState();
    if (state.users.has(i.email)) return ok({ kind: "exists" });
    if (typeof i.password !== "string" || i.password.length < MIN_PASSWORD) {
      return fail("invalid_password");
    }
    const sub = `u${randomBytes(12).toString("hex")}`;
    state.users.set(i.email, {
      sub,
      password: i.password,
      confirmed: false,
      name: i.name,
      locale: i.locale,
      refreshCount: 0,
    });
    this.issueCode(i.email, "signup");
    return ok({ kind: "created", sub });
  }

  async confirmSignUp(i: { email: string; code: string }): Promise<IdpResult<true>> {
    const user = getFakeState().users.get(i.email);
    if (user === undefined) return fail("invalid_code");
    const checked = this.checkCode(i.email, i.code, "signup");
    if (!checked.ok) return checked;
    user.confirmed = true;
    getFakeState().emailCodes.delete(i.email);
    return ok(true);
  }

  async resendConfirmationCode(email: string): Promise<IdpResult<true>> {
    const user = getFakeState().users.get(email);
    // An unknown or already confirmed address answers ok and records nothing (enumeration rule).
    if (user !== undefined && !user.confirmed) this.issueCode(email, "signup");
    return ok(true);
  }

  async signIn(i: {
    email: string;
    password: string;
    totpCode?: string;
    beforeCode?: () => Promise<boolean>;
  }): Promise<IdpResult<SignInOutcome>> {
    const state = getFakeState();
    const user = state.users.get(i.email);
    if (user === undefined || user.password !== i.password) return fail("denied");
    if (!user.confirmed) return fail("not_confirmed");
    let viaTotp = false;
    // WPU-X11: as the Cognito adapter does, a customer with an authenticator gets the challenge without
    // a code, and a wrong or reused code is `denied`.
    if (user.totpEnabled === true && user.totpSecret !== undefined) {
      if (i.totpCode === undefined) return ok({ kind: "challenge", challenge: "totp" });
      // The password is proven: the caller may refuse the code (its wrong-code limit), as in the adapter.
      if (i.beforeCode !== undefined) {
        let go: boolean;
        try {
          go = (await i.beforeCode()) === true;
        } catch {
          go = false;
        }
        if (!go) return fail("code_limited");
      }
      state.totpAnswerCalls += 1;
      // The password was right: a wrong or reused code is code_denied, as in the Cognito adapter.
      if (!acceptTotp(user, user.totpSecret, i.totpCode, this.clock.now())) {
        return fail("code_denied");
      }
      viaTotp = true;
    }
    user.refreshCount += 1;
    const refreshToken = `fake-rt.${user.sub}.${user.refreshCount}`;
    state.issuedRefresh.add(refreshToken);
    return ok({
      kind: "tokens",
      accessToken: `dev.${user.sub}`,
      refreshToken,
      expiresInSeconds: 3600,
      ...(viaTotp ? { totpVerified: true as const } : {}),
    });
  }

  async forgotPassword(email: string): Promise<IdpResult<true>> {
    const user = getFakeState().users.get(email);
    if (user !== undefined && user.confirmed) this.issueCode(email, "reset");
    return ok(true);
  }

  async confirmForgotPassword(i: {
    email: string;
    code: string;
    newPassword: string;
  }): Promise<IdpResult<true>> {
    const user = getFakeState().users.get(i.email);
    if (user === undefined) return fail("invalid_code");
    const checked = this.checkCode(i.email, i.code, "reset");
    if (!checked.ok) return checked;
    if (typeof i.newPassword !== "string" || i.newPassword.length < MIN_PASSWORD) {
      return fail("invalid_password");
    }
    user.password = i.newPassword;
    getFakeState().emailCodes.delete(i.email);
    return ok(true);
  }

  async revokeRefreshToken(refreshToken: string): Promise<IdpResult<true>> {
    getFakeState().issuedRefresh.delete(refreshToken);
    return ok(true);
  }
}

/** Accepts only a refresh token this process issued; returns the dev access token of its subject. */
export function fakeRefreshPort(): RefreshPort {
  return {
    async refresh(refreshToken: string): Promise<RefreshResult> {
      const state = getFakeState();
      const match = /^fake-rt\.([A-Za-z0-9_-]{1,64})\.\d+$/.exec(refreshToken);
      if (match === null || !state.issuedRefresh.has(refreshToken)) return { kind: "rejected" };
      return { kind: "refreshed", accessToken: `dev.${match[1] as string}` };
    },
  };
}

/** The factories runtime.ts and proxy-auth.ts call, so that the class and port names stay in this folder. */
export function createFakeIdentity(opts: {
  stage: Stage;
  fakes: boolean;
  clock?: Clock;
}): IdentityProvider {
  return new InMemoryIdentityProvider(opts);
}

export function createFakeRefreshPort(): RefreshPort {
  return fakeRefreshPort();
}
