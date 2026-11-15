import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMIT_KEY, NOW, SIGN_UP_FORM, goodHeaders, makeHarness } from "../fakes/auth-harness.ts";
import type { Customer, Harness } from "../fakes/auth-harness.ts";
import { getFakeState } from "../fakes/outbox.ts";
import { totpCodeAt } from "../fakes/totp.ts";
import { authBn } from "../../messages/auth-bn.ts";
import { authEn } from "../../messages/auth-en.ts";
import { signInCore } from "./sign-in.ts";

let h: Harness;
let customer: Customer;
const FORM = { email: SIGN_UP_FORM.email, password: SIGN_UP_FORM.password, locale: "bn" };

beforeEach(async () => {
  h = makeHarness();
  customer = await h.signedUp();
});

describe("signInCore", () => {
  it("sets the two cookies only when completeSignIn is ok, and audits with the customer id and the viewer address", async () => {
    const out = await signInCore(h.ctx(), FORM);
    expect(out.effects.setCookies.map((c) => c.name)).toEqual(["__Host-tc_at", "__Host-tc_rt"]);
    expect(
      out.effects.setCookies.every((c) => c.httpOnly && c.secure && c.sameSite === "lax"),
    ).toBe(true);
    expect(h.audits).toEqual([
      { customerId: customer.customerId, action: "auth.sign_in", ip: "198.51.100.7" },
    ]);
  });

  it("an unverified phone lands on /verify with a safe next kept", async () => {
    const out = await signInCore(h.ctx(), { ...FORM, next: "/wallet" });
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/verify?next=%2Fwallet" });
  });

  it("a verified phone lands on next or the default landing", async () => {
    customer.phoneVerified = true;
    expect((await signInCore(h.ctx(), FORM)).state).toEqual({
      status: "done",
      redirectTo: "/en/wallet",
    });
    expect((await signInCore(h.ctx(), { ...FORM, locale: "en" })).state).toEqual({
      status: "done",
      redirectTo: "/en/wallet",
    });
  });

  it("an unknown subject, a revoked token and a suspended customer set no cookie", async () => {
    customer.revoked = true;
    const revoked = await signInCore(h.ctx(), FORM);
    expect(revoked.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    expect(revoked.effects.setCookies).toEqual([]);

    customer.revoked = false;
    customer.suspended = true;
    const suspended = await signInCore(h.ctx(), FORM);
    expect(suspended.state).toMatchObject({ status: "error", code: "suspended" });
    expect(suspended.effects.setCookies).toEqual([]);

    h.customers.clear();
    const unknown = await signInCore(h.ctx(), FORM);
    expect(unknown.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    expect(unknown.effects.setCookies).toEqual([]);
  });

  it("if the audit row cannot be written no cookie is set (R16)", async () => {
    h.state.auditFails = true;
    const out = await signInCore(h.ctx(), FORM);
    expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
    expect(out.effects.setCookies).toEqual([]);
  });

  it("another challenge than TOTP (a new password, ...) is refused closed as unavailable", async () => {
    const original = h.idp.signIn;
    h.idp.signIn = async () => ({ ok: true, value: { kind: "challenge", challenge: "other" } });
    const out = await signInCore(h.ctx(), FORM);
    h.idp.signIn = original;
    expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
    expect(out.effects.setCookies).toEqual([]);
  });
});

// WPU-X11: a customer who switched the authenticator on signs in with the password and the 6-digit code.
describe("signInCore with an authenticator (TOTP)", () => {
  const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  beforeEach(() => {
    const user = getFakeState().users.get(FORM.email)!;
    user.totpSecret = SECRET;
    user.totpEnabled = true;
  });

  it("without a code: no cookie, the form asks for the code and keeps the e-mail, never the password", async () => {
    const out = await signInCore(h.ctx(), FORM);
    expect(out.state).toMatchObject({
      status: "error",
      code: "totp_required",
      values: { email: FORM.email, totpStep: "1" },
    });
    expect(JSON.stringify(out.state)).not.toContain(FORM.password);
    expect(out.effects.setCookies).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("with the right code: the normal session, cookies and audit", async () => {
    const out = await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
    expect(out.effects.setCookies.map((c) => c.name)).toEqual(["__Host-tc_at", "__Host-tc_rt"]);
    expect(h.audits).toEqual([
      { customerId: customer.customerId, action: "auth.sign_in", ip: "198.51.100.7" },
    ]);
  });

  it("a code typed in Bengali digits is read as the same code", async () => {
    const code = totpCodeAt(SECRET, NOW).replace(/[0-9]/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]!);
    const out = await signInCore(h.ctx(), { ...FORM, totpCode: code });
    expect(out.state).toMatchObject({ status: "done" });
  });

  it("a wrong code is the generic sign_in_failed, keeps the code step, sets no cookie and does not echo the code", async () => {
    const right = totpCodeAt(SECRET, NOW);
    const wrong = right === "000000" ? "111111" : "000000";
    const out = await signInCore(h.ctx(), { ...FORM, totpCode: wrong, totpStep: "1" });
    expect(out.state).toMatchObject({
      status: "error",
      code: "sign_in_failed",
      values: { totpStep: "1" },
    });
    expect(JSON.stringify(out.state)).not.toContain(wrong);
    expect(out.effects.setCookies).toEqual([]);
  });

  it("a code is accepted once: the replay of an accepted code is refused", async () => {
    const code = totpCodeAt(SECRET, NOW);
    expect((await signInCore(h.ctx(), { ...FORM, totpCode: code })).state).toMatchObject({
      status: "done",
    });
    const replay = await signInCore(h.ctx(), { ...FORM, totpCode: code });
    expect(replay.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    expect(replay.effects.setCookies).toEqual([]);
  });

  it("a code that is not six digits is a field error before the provider is asked", async () => {
    h.events.length = 0;
    const out = await signInCore(h.ctx(), { ...FORM, totpCode: "12ab" });
    expect(out.state).toMatchObject({
      status: "error",
      code: "invalid",
      fields: { totpCode: "invalid" },
    });
    expect(h.events.filter((e) => e.startsWith("idp."))).toEqual([]);
  });

  // WPU-X11 round 2 (security review, findings 2b and 4).
  it("tells the audit step whether the tokens answered the authenticator challenge", async () => {
    await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
    expect(h.signIns).toEqual([{ customerId: customer.customerId, totpVerified: true }]);
    // The authenticator switched off outside the app: the same account signs in with no challenge, and the
    // step that audits the sign-in is told the flow had none (it then clears the platform copy).
    const user = getFakeState().users.get(FORM.email)!;
    user.totpEnabled = false;
    await signInCore(h.ctx(), FORM);
    expect(h.signIns.at(-1)).toEqual({ customerId: customer.customerId, totpVerified: false });
  });

  // The counters of the wrong-code rules (5 in 15 minutes, 20 a day), one number per rule and window.
  const codeCounts = () =>
    [...h.counts.entries()].filter(([k]) => k.includes("auth.signin_code")).map(([, n]) => n);

  const wrongCode = () => {
    const right = totpCodeAt(SECRET, NOW);
    return right === "000000" ? "111111" : "000000";
  };

  it("counts a wrong code after a correct password; the fifth fills the limit, answers rate_limited and sends the notice once", async () => {
    for (let i = 1; i <= 4; i++) {
      const out = await signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() });
      expect(out.state).toMatchObject({ status: "error", code: "sign_in_failed" });
      expect(h.notices).toEqual([]);
    }
    const fifth = await signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() });
    expect(fifth.state).toMatchObject({ status: "error", code: "rate_limited" });
    expect(fifth.effects.setCookies).toEqual([]);
    expect(h.notices).toEqual([{ email: FORM.email, ip: "198.51.100.7", key: LIMIT_KEY }]);
  });

  it("then blocks: even the right code is refused, after the password step and before any code is sent, and no second notice goes out", async () => {
    for (let i = 0; i < 5; i++) await signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() });
    const answered = getFakeState().totpAnswerCalls;
    h.events.length = 0;
    const blocked = await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
    expect(blocked.state).toMatchObject({ status: "error", code: "rate_limited" });
    expect(blocked.effects.setCookies).toEqual([]);
    // The password was checked (that is what the reservation waits for); no code reached the challenge.
    expect(h.events.filter((e) => e === "idp.signIn")).toHaveLength(1);
    expect(getFakeState().totpAnswerCalls).toBe(answered);
    expect(h.notices).toHaveLength(1);
    // The refusal says nothing about codes: the same words as any rate limit.
    // ... the screen shows the plain rate-limit text, which names no code and no authenticator.
    expect(authEn.Auth.error.rate_limited).not.toMatch(/code|authenticator/i);
    expect(authBn.Auth.error.rate_limited).not.toMatch(/কোড|অথেনটিকেটর/);
    expect(JSON.stringify(blocked.state)).not.toContain("totpCode");
  });

  it("a wrong password with a code is not counted and sends no notice; a right code does not count", async () => {
    for (let i = 0; i < 8; i++) {
      const out = await signInCore(h.ctx(), {
        ...FORM,
        password: "wrong wrong wrong",
        totpCode: wrongCode(),
      });
      // The pair limit of the password step still applies (8 in 15 minutes): the first eight are plain failures.
      expect(out.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    }
    expect(h.notices).toEqual([]);
    // The attempt is reserved before the provider is asked and given back when it was not a wrong code.
    expect(codeCounts().every((n) => n === 0)).toBe(true);
  });

  it("a successful code sign-in leaves the wrong-code counters where they were", async () => {
    await signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() });
    const before = codeCounts();
    expect(before.some((n) => n > 0)).toBe(true);
    const ok = await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
    expect(ok.state).toMatchObject({ status: "done" });
    expect(codeCounts()).toEqual(before);
  });

  it("every outcome but a wrong code gives the reservation back: the provider unavailable, its own rate limit, another challenge, a suspended customer", async () => {
    const reserved = async (arrange: () => void, restore: () => void) => {
      arrange();
      await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
      restore();
    };
    const original = h.idp.signIn;
    await reserved(
      () => (h.state.idpDown = true),
      () => (h.state.idpDown = false),
    );
    for (const answer of [
      { ok: false, kind: "rate_limited" },
      { ok: false, kind: "unavailable" },
      { ok: true, value: { kind: "challenge", challenge: "other" } },
    ] as const) {
      await reserved(
        () => (h.idp.signIn = async () => answer as never),
        () => (h.idp.signIn = original),
      );
    }
    customer.suspended = true;
    await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
    expect(codeCounts().every((n) => n === 0)).toBe(true);
  });

  // The review: peek-then-count lets N parallel guesses all pass the check before any is counted. The attempt
  // is reserved up front (one atomic count), so no more than the limit ever reaches the provider.
  it("parallel wrong codes: no more than the limit reach the provider, whatever the interleaving", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() })),
    );
    // The password step is the existing per-address limit (8 in 15 minutes); a CODE reaches the challenge
    // only for the first five reservations, whatever the interleaving.
    expect(getFakeState().totpAnswerCalls).toBeLessThanOrEqual(5);
    expect(getFakeState().totpAnswerCalls).toBeGreaterThan(0);
    // The rest were refused, with the plain rate-limit answer.
    const limited = attempts.filter(
      (a) => a.state.status === "error" && a.state.code === "rate_limited",
    );
    expect(limited.length).toBeGreaterThanOrEqual(12 - 5);
    expect(attempts.every((a) => a.effects.setCookies.length === 0)).toBe(true);
    // One notice for the window, not one per failure.
    expect(h.notices).toHaveLength(1);
  });

  // The review: the reservation was made before the password was proven, so an attacker WITHOUT the password
  // could fill the owner's counters with parallel sign-ins that carry a code. Now the counter is touched
  // only after the password step answered the authenticator challenge.
  it("a flood of wrong-PASSWORD sign-ins with a code never touches the owner's wrong-code counters: the owner, in the middle of the flood, signs in, and again afterwards", async () => {
    const attackerIp = (n: number) => `203.0.113.${n + 1}:4711`;
    const owner = signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
    const flood = Array.from({ length: 30 }, (_, n) =>
      signInCore(h.ctx(goodHeaders({ "cloudfront-viewer-address": attackerIp(n) })), {
        ...FORM,
        password: "not the password",
        totpCode: wrongCode(),
      }),
    );
    // The owner's request is started last of all, so it meets the whole flood in flight. With the
    // reservation made before the password was proven, the first five attackers would have filled the
    // counter and the owner would have been refused.
    const late = signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
    const [floodAnswers, ownerFirst, ownerLate] = await Promise.all([
      Promise.all(flood),
      owner,
      late,
    ]);
    expect(floodAnswers.every((o) => o.state.status === "error")).toBe(true);
    expect(floodAnswers.every((o) => o.effects.setCookies.length === 0)).toBe(true);
    // Exactly one of the owner's two parallel sign-ins can use the code (a code is accepted once); neither
    // was refused by the wrong-code limit.
    const states = [ownerFirst, ownerLate].map((o) => o.state);
    expect(states.filter((x) => x.status === "done")).toHaveLength(1);
    expect(states.some((x) => x.status === "error" && x.code === "rate_limited")).toBe(false);
    // No attacker reached the code step: only the owner's two parallel requests sent a code (the same code
    // twice: the first is accepted, the replay is a wrong code and stays counted, once). So the counters
    // hold exactly that one hit in each of the two rules (15 minutes, a day), and nothing else.
    expect(getFakeState().totpAnswerCalls).toBe(2);
    expect(codeCounts().sort()).toEqual([0, 0].map(() => 1));
    expect(h.notices).toEqual([]);
    // Later, after the windows of the password limits, the owner signs in with a fresh code.
    h.advance(61 * 60_000);
    const again = await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, h.now()) });
    expect(again.state).toMatchObject({ status: "done" });
  });

  // Review (LOW): the release must name the window of the reservation, so the reservation hands back the
  // very time its count used and the sign-in gives that time to the release.
  it("the release uses the time of the reservation that was counted, not a clock read of its own", async () => {
    const counted = new Date(NOW.getTime() + 7 * 60_000);
    const released: Date[] = [];
    const reserve = h.ports.limitReserve.bind(h.ports);
    const release = h.ports.limitRelease.bind(h.ports);
    h.ports.limitReserve = async (action, who, key) => {
      const answer = await reserve(action, who, key);
      return answer.allowed ? { allowed: true, at: counted } : answer;
    };
    h.ports.limitRelease = async (action, who, key, at) => {
      released.push(at);
      return release(action, who, key, at);
    };
    const ok = await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
    expect(ok.state).toMatchObject({ status: "done" });
    expect(released).toEqual([counted]);
  });

  it("a flood from one address with the wrong password and a code is stopped by the password limits and counts no code", async () => {
    const flood = await Promise.all(
      Array.from({ length: 50 }, () =>
        signInCore(h.ctx(), { ...FORM, password: "not the password", totpCode: wrongCode() }),
      ),
    );
    expect(
      flood.filter((o) => o.state.status === "error" && o.state.code === "rate_limited").length,
    ).toBe(42);
    expect(codeCounts().every((n) => n === 0)).toBe(true);
  });

  it("parallel attempts with the RIGHT code and wrong ones: the right one is never counted against the others", async () => {
    const right = totpCodeAt(SECRET, NOW);
    const out = await Promise.all([
      signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() }),
      signInCore(h.ctx(), { ...FORM, totpCode: right }),
      signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() }),
    ]);
    expect(out.filter((o) => o.state.status === "done")).toHaveLength(1);
    // Two wrong codes stay counted, the right one was given back.
    expect(codeCounts().reduce((a, b) => Math.max(a, b), 0)).toBe(2);
  });

  it("a replay of an accepted code is a wrong code: it counts", async () => {
    const code = totpCodeAt(SECRET, NOW);
    await signInCore(h.ctx(), { ...FORM, totpCode: code });
    expect(codeCounts().every((n) => n === 0)).toBe(true);
    await signInCore(h.ctx(), { ...FORM, totpCode: code });
    expect(codeCounts().some((n) => n > 0)).toBe(true);
  });

  // Review: a refused reservation used to leave the daily rule counted (rules are counted in key order).
  it("while blocked for the quarter hour, ten more coded attempts leave the daily wrong-code count where it was", async () => {
    for (let i = 0; i < 5; i++) await signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() });
    const daily = () =>
      [...h.counts.entries()]
        .filter(([k]) => k.includes("auth.signin_code:86400"))
        .map(([, n]) => n);
    expect(daily()).toEqual([5]);
    for (let i = 0; i < 10; i++) {
      const out = await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
      expect(out.state).toMatchObject({ status: "error", code: "rate_limited" });
    }
    expect(daily()).toEqual([5]);
    // Fifteen minutes later the quarter hour is free again and the owner still has 15 of the day.
    h.advance(16 * 60_000);
    const ok = await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, h.now()) });
    expect(ok.state).toMatchObject({ status: "done" });
  });

  it("a notice that cannot be queued does not change the answer", async () => {
    h.state.noticeFails = true;
    for (let i = 0; i < 4; i++) await signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() });
    const fifth = await signInCore(h.ctx(), { ...FORM, totpCode: wrongCode() });
    expect(fifth.state).toMatchObject({ status: "error", code: "rate_limited" });
  });

  it("wrong codes count against the sign-in limit: the ninth try is rate_limited", async () => {
    const right = totpCodeAt(SECRET, NOW);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 8; i++) {
      await signInCore(h.ctx(), { ...FORM, totpCode: wrong });
    }
    expect((await signInCore(h.ctx(), { ...FORM, totpCode: right })).state).toMatchObject({
      code: "rate_limited",
    });
  });

  it("the ninth attempt in fifteen minutes from one address for one email is rate_limited", async () => {
    const wrong = { ...FORM, password: "wrong wrong wrong" };
    for (let i = 0; i < 8; i++) {
      expect((await signInCore(h.ctx(), wrong)).state).toMatchObject({ code: "sign_in_failed" });
    }
    const ninth = await signInCore(h.ctx(), wrong);
    expect(ninth.state).toMatchObject({
      status: "error",
      code: "rate_limited",
      retryAfterSeconds: 123,
    });
    // Even the right password is refused now: the limiter comes before the provider.
    expect((await signInCore(h.ctx(), FORM)).state).toMatchObject({ code: "rate_limited" });
  });

  it("the provider's own rate limit is shown as rate_limited and an outage as unavailable", async () => {
    h.state.idpDown = true;
    expect((await signInCore(h.ctx(), FORM)).state).toMatchObject({ code: "unavailable" });
  });

  it("a signed-in customer who posts the form again is sent on without a provider call", async () => {
    h.state.session = {
      customerId: customer.customerId,
      kycStatus: "none",
      riskTier: "new",
      locale: "bn",
      signedInAt: new Date(),
    };
    h.events.length = 0;
    const out = await signInCore(h.ctx(), FORM);
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/wallet" });
    expect(h.events.filter((e) => e.startsWith("idp."))).toEqual([]);
  });
});

// WPU-X23: the sign-in again of a signed-in customer (reauth=1) runs the whole flow and issues new tokens.
describe("signInCore with reauth=1 (step-up sign-in)", () => {
  const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const signedIn = () => {
    h.state.session = {
      customerId: customer.customerId,
      kycStatus: "none",
      riskTier: "new",
      locale: "en",
      signedInAt: new Date(NOW.getTime() - 3_600_000),
    };
  };
  const REAUTH = { ...FORM, reauth: "1", next: "/containers" };

  it("runs the password step and sets new cookies for the same customer", async () => {
    signedIn();
    h.events.length = 0;
    const out = await signInCore(h.ctx(), REAUTH);
    expect(h.events.some((e) => e.startsWith("idp."))).toBe(true);
    expect(out.effects.setCookies.map((c) => c.name)).toEqual(["__Host-tc_at", "__Host-tc_rt"]);
    expect(out.state.status).toBe("done");
  });

  it("asks for the authenticator code when it is on, and sets no cookie before the code", async () => {
    const user = getFakeState().users.get(FORM.email)!;
    user.totpSecret = SECRET;
    user.totpEnabled = true;
    signedIn();
    const first = await signInCore(h.ctx(), REAUTH);
    expect(first.state).toMatchObject({ status: "error", code: "totp_required" });
    expect(first.effects.setCookies).toEqual([]);
    const second = await signInCore(h.ctx(), {
      ...REAUTH,
      totpCode: totpCodeAt(SECRET, NOW),
      totpStep: "1",
    });
    expect(second.state.status).toBe("done");
    expect(second.effects.setCookies).toHaveLength(2);
  });

  it("refuses another customer's credentials: no cookie, the old session is untouched", async () => {
    const other = await h.signedUp("other@example.com");
    expect(other.customerId).not.toBe(customer.customerId);
    signedIn();
    const out = await signInCore(h.ctx(), {
      ...REAUTH,
      email: "other@example.com",
    });
    expect(out.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    expect(out.effects.setCookies).toEqual([]);
    // R9: one audit row, for the customer who is signed in, and nothing of the other account in it.
    const refused = h.audits.filter((a) => a.action === "auth.reauth_refused");
    expect(refused).toEqual([
      { customerId: customer.customerId, action: "auth.reauth_refused", ip: "198.51.100.7" },
    ]);
    expect(JSON.stringify(h.audits)).not.toContain("other@example.com");
    expect(JSON.stringify(h.audits)).not.toContain(other.customerId);
  });

  // WPU-X27 (L3 of the WPU-X23 review): the refresh token of the replaced session is revoked at the provider.
  describe("the replaced refresh token", () => {
    const OLD = "fake-rt.old-token.1";
    const withRevoke = (revoke: (t: string) => Promise<unknown>, pinNew?: string) => {
      const base = h.ctx();
      const realSignIn = base.runtime.identity!.signIn.bind(base.runtime.identity);
      const calls: string[] = [];
      const ctx = {
        ...base,
        runtime: {
          ...base.runtime,
          identity: {
            ...base.runtime.identity!,
            signIn: async (...a: Parameters<typeof realSignIn>) => {
              const r = await realSignIn(...a);
              if (pinNew !== undefined && r.ok && r.value.kind === "tokens") {
                return { ...r, value: { ...r.value, refreshToken: pinNew } };
              }
              return r;
            },
            revokeRefreshToken: async (t: string) => {
              calls.push(t);
              return revoke(t);
            },
          },
        },
      } as unknown as ReturnType<typeof h.ctx>;
      return { ctx, calls };
    };

    it("is revoked once, after the new cookies are ready", async () => {
      signedIn();
      const { ctx, calls } = withRevoke(async () => ({ ok: true, value: true }));
      const out = await signInCore(ctx, REAUTH, OLD);
      expect(out.state.status).toBe("done");
      expect(calls).toEqual([OLD]);
    });

    it("is not revoked when the new token equals the old one, is empty, or is absent", async () => {
      signedIn();
      const a = withRevoke(async () => ({ ok: true, value: true }));
      const first = await signInCore(a.ctx, REAUTH, undefined);
      expect(first.state.status).toBe("done");
      const b = withRevoke(async () => ({ ok: true, value: true }), OLD);
      await signInCore(b.ctx, REAUTH, OLD);
      const c = withRevoke(async () => ({ ok: true, value: true }));
      await signInCore(c.ctx, REAUTH, "");
      expect([a.calls, b.calls, c.calls]).toEqual([[], [], []]);
    });

    it("is not revoked without reauth, when the customer differs, or when the sign-in fails", async () => {
      signedIn();
      const plain = withRevoke(async () => ({ ok: true, value: true }));
      await signInCore(plain.ctx, { ...FORM, next: "/containers" }, OLD);
      await h.signedUp("other@example.com");
      const other = withRevoke(async () => ({ ok: true, value: true }));
      await signInCore(other.ctx, { ...REAUTH, email: "other@example.com" }, OLD);
      const wrong = withRevoke(async () => ({ ok: true, value: true }));
      await signInCore(wrong.ctx, { ...REAUTH, password: "Wrong-password-1!" }, OLD);
      expect([plain.calls, other.calls, wrong.calls]).toEqual([[], [], []]);
    });

    it("a failed or throwing revoke never fails the sign-in and logs a fixed text without the token", async () => {
      signedIn();
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      try {
        for (const revoke of [
          async () => ({ ok: false, kind: "unavailable" }),
          async () => {
            throw new Error(`boom ${OLD}`);
          },
        ]) {
          const { ctx, calls } = withRevoke(revoke);
          const out = await signInCore(ctx, REAUTH, OLD);
          expect(out.state.status).toBe("done");
          expect(out.effects.setCookies).toHaveLength(2);
          expect(calls).toEqual([OLD]);
        }
      } finally {
        spy.mockRestore();
      }
      expect(lines.filter((l) => l.includes("old_token_revoke_failed"))).toHaveLength(2);
      expect(lines.join("\n")).not.toContain(OLD);
    });
  });

  it("without reauth=1 a signed-in customer is still sent on", async () => {
    signedIn();
    h.events.length = 0;
    const out = await signInCore(h.ctx(), { ...FORM, next: "/containers" });
    expect(out.state.status).toBe("done");
    expect(h.events.filter((e) => e.startsWith("idp."))).toEqual([]);
  });

  it("a hostile next stays off the U12 list after a reauth", async () => {
    signedIn();
    const out = await signInCore(h.ctx(), { ...REAUTH, next: "//evil.example" });
    expect(JSON.stringify(out.state)).not.toContain("evil");
  });
});
