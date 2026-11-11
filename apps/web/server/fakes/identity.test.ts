import { sessionCookieSpecs } from "@tc/auth";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryIdentityProvider, fakeRefreshPort } from "./identity.ts";
import { getFakeSms, getFakeState, resetFakeState } from "./outbox.ts";
import { devVerifier } from "./dev-auth.ts";

let now = new Date("2026-11-12T10:00:00.000Z");
const clock = { now: () => now };
const make = () => new InMemoryIdentityProvider({ stage: "test", fakes: true, clock });

const SIGN_UP = {
  email: "rahim@example.test",
  password: "correct horse 99",
  name: "Rahim",
  locale: "bn",
} as const;

async function confirmed(idp: InMemoryIdentityProvider) {
  const created = await idp.signUp(SIGN_UP);
  const code = getFakeState().emailCodes.get(SIGN_UP.email)?.code ?? "";
  await idp.confirmSignUp({ email: SIGN_UP.email, code });
  return created;
}

beforeEach(() => {
  now = new Date("2026-11-12T10:00:00.000Z");
  resetFakeState();
});

describe("the in-memory identity provider", () => {
  it("refuses to be built in a production-like place", () => {
    expect(() => new InMemoryIdentityProvider({ stage: "production", fakes: true })).toThrow();
    expect(() => new InMemoryIdentityProvider({ stage: "staging", fakes: true })).toThrow();
    expect(() => new InMemoryIdentityProvider({ stage: "local", fakes: false })).toThrow();
  });

  it("refuses when NODE_ENV is production", () => {
    const before = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(() => new InMemoryIdentityProvider({ stage: "local", fakes: true })).toThrow();
    } finally {
      (process.env as Record<string, string>).NODE_ENV = before as string;
    }
  });

  it("sign-up, confirm with the emailed code, sign-in gives dev tokens a cookie spec accepts", async () => {
    const idp = make();
    const created = await idp.signUp(SIGN_UP);
    expect(created.ok && created.value.kind).toBe("created");
    const code = getFakeState().emailCodes.get(SIGN_UP.email)?.code ?? "";
    expect(code).toMatch(/^\d{6}$/);
    expect(await idp.confirmSignUp({ email: SIGN_UP.email, code })).toEqual({
      ok: true,
      value: true,
    });
    const tokens = await idp.signIn({ email: SIGN_UP.email, password: SIGN_UP.password });
    expect(tokens.ok).toBe(true);
    if (!tokens.ok || tokens.value.kind !== "tokens") throw new Error("no tokens");
    const sub = created.ok && created.value.kind === "created" ? created.value.sub : "";
    expect(tokens.value.accessToken).toBe(`dev.${sub}`);
    expect(tokens.value.refreshToken).toBe(`fake-rt.${sub}.1`);
    const specs = sessionCookieSpecs(
      {
        accessToken: tokens.value.accessToken,
        refreshToken: tokens.value.refreshToken,
        accessExpiresAt: new Date(now.getTime() + tokens.value.expiresInSeconds * 1000),
      },
      clock,
    );
    expect(specs).toHaveLength(2);
    const verified = await devVerifier.verify(tokens.value.accessToken);
    expect(verified.ok && verified.token.sub).toBe(sub);
  });

  it("an existing address answers exists", async () => {
    const idp = make();
    await idp.signUp(SIGN_UP);
    expect(await idp.signUp(SIGN_UP)).toEqual({ ok: true, value: { kind: "exists" } });
  });

  it("a wrong code and an expired code are told apart only by the provider kind", async () => {
    const idp = make();
    await idp.signUp(SIGN_UP);
    expect(await idp.confirmSignUp({ email: SIGN_UP.email, code: "000000" })).toEqual({
      ok: false,
      kind: "invalid_code",
    });
    const code = getFakeState().emailCodes.get(SIGN_UP.email)?.code ?? "";
    now = new Date(now.getTime() + 31 * 60 * 1000);
    expect(await idp.confirmSignUp({ email: SIGN_UP.email, code })).toEqual({
      ok: false,
      kind: "expired_code",
    });
    expect(await idp.confirmSignUp({ email: "nobody@example.test", code })).toEqual({
      ok: false,
      kind: "invalid_code",
    });
  });

  it("forgot and resend for an unknown address answer ok and record nothing", async () => {
    const idp = make();
    expect(await idp.forgotPassword("nobody@example.test")).toEqual({ ok: true, value: true });
    expect(await idp.resendConfirmationCode("nobody@example.test")).toEqual({
      ok: true,
      value: true,
    });
    expect(getFakeState().emailCodes.size).toBe(0);
  });

  it("sign-in: unconfirmed is not_confirmed, unknown and wrong password are denied", async () => {
    const idp = make();
    await idp.signUp(SIGN_UP);
    expect(await idp.signIn({ email: SIGN_UP.email, password: SIGN_UP.password })).toEqual({
      ok: false,
      kind: "not_confirmed",
    });
    expect(await idp.signIn({ email: "nobody@example.test", password: "x".repeat(12) })).toEqual({
      ok: false,
      kind: "denied",
    });
    expect(await idp.signIn({ email: SIGN_UP.email, password: "wrong wrong wrong" })).toEqual({
      ok: false,
      kind: "denied",
    });
  });

  it("a reset changes the password: the old one is denied, the new one works", async () => {
    const idp = make();
    await confirmed(idp);
    await idp.forgotPassword(SIGN_UP.email);
    const code = getFakeState().emailCodes.get(SIGN_UP.email)?.code ?? "";
    const done = await idp.confirmForgotPassword({
      email: SIGN_UP.email,
      code,
      newPassword: "another long password 7",
    });
    expect(done.ok).toBe(true);
    expect((await idp.signIn({ email: SIGN_UP.email, password: SIGN_UP.password })).ok).toBe(false);
    const fresh = await idp.signIn({ email: SIGN_UP.email, password: "another long password 7" });
    expect(fresh.ok).toBe(true);
  });

  it("five wrong codes lock nothing (the limiter is ours)", async () => {
    const idp = make();
    await idp.signUp(SIGN_UP);
    for (let i = 0; i < 5; i++) {
      await idp.confirmSignUp({ email: SIGN_UP.email, code: "000000" });
    }
    const code = getFakeState().emailCodes.get(SIGN_UP.email)?.code ?? "";
    expect((await idp.confirmSignUp({ email: SIGN_UP.email, code })).ok).toBe(true);
  });

  it("the fake refresh port accepts only a token this process issued", async () => {
    const idp = make();
    const created = await confirmed(idp);
    const sub = created.ok && created.value.kind === "created" ? created.value.sub : "";
    const signedIn = await idp.signIn({ email: SIGN_UP.email, password: SIGN_UP.password });
    const refresh =
      signedIn.ok && signedIn.value.kind === "tokens" ? signedIn.value.refreshToken : "";
    const port = fakeRefreshPort();
    expect(await port.refresh(refresh)).toEqual({ kind: "refreshed", accessToken: `dev.${sub}` });
    expect(await port.refresh(`fake-rt.${sub}.99`)).toEqual({ kind: "rejected" });
    expect(await port.refresh("anything")).toEqual({ kind: "rejected" });
    await idp.revokeRefreshToken(refresh);
    expect(await port.refresh(refresh)).toEqual({ kind: "rejected" });
  });

  it("the fake SMS gateway is one shared in-memory provider", () => {
    expect(getFakeSms()).toBe(getFakeSms());
  });
});
