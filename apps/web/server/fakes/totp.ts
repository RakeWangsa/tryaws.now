import { createHmac, randomBytes } from "node:crypto";
import type { IdpResult, TotpPort } from "@tc/auth";
import type { Clock } from "@tc/core";
import { getFakeState, type FakeUser } from "./outbox.ts";

// Development and test only (WPU-X11): the customer's authenticator as the fake identity provider keeps
// it. The codes are real RFC 6238 codes (HMAC-SHA1, 6 digits, 30 seconds, node:crypto: no dependency),
// so a test computes the code a phone app would show with `totpCodeAt`. A code is accepted for the step
// before, the step of and the step after the clock, and only once (replay refused), as Cognito does.
// The access token of the fake is `dev.<sub>` (identity.ts). Never imported by the production runtime.

const STEP_SECONDS = 30;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("fake totp: not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function codeOfStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

const stepOf = (at: Date): number => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

/** The code an authenticator app shows for `secret` at `at`. For tests and local runs. */
export function totpCodeAt(secret: string, at: Date): string {
  return codeOfStep(secret, stepOf(at));
}

/** Accepts a code of the step before, of or after `now`, once. Records the step on success. */
export function acceptTotp(user: FakeUser, secret: string, code: string, now: Date): boolean {
  if (!/^[0-9]{6}$/.test(code)) return false;
  const current = stepOf(now);
  for (const step of [current - 1, current, current + 1]) {
    if (codeOfStep(secret, step) !== code) continue;
    if (user.totpLastStep !== undefined && step <= user.totpLastStep) return false;
    user.totpLastStep = step;
    return true;
  }
  return false;
}

function userOfToken(accessToken: string): FakeUser | undefined {
  const match = /^dev\.([A-Za-z0-9_-]{1,64})$/.exec(accessToken);
  if (match === null) return undefined;
  for (const user of getFakeState().users.values()) {
    if (user.sub === match[1]) return user;
  }
  return undefined;
}

const denied = (): IdpResult<never> => ({ ok: false, kind: "denied" });

export class FakeTotp implements TotpPort {
  readonly calls: string[] = [];
  private readonly clock: Clock;

  constructor(clock: Clock = { now: () => new Date() }) {
    const env = process.env.NODE_ENV;
    if (env !== "development" && env !== "test") {
      throw new Error("FakeTotp is for tests and local runs only");
    }
    this.clock = clock;
  }

  async associate(accessToken: string): Promise<IdpResult<{ secret: string }>> {
    this.calls.push("associate");
    const user = userOfToken(accessToken);
    if (user === undefined) return denied();
    const secret = base32Encode(randomBytes(20));
    user.totpPending = secret;
    return { ok: true, value: { secret } };
  }

  async verify(accessToken: string, code: string): Promise<IdpResult<true>> {
    this.calls.push("verify");
    const user = userOfToken(accessToken);
    if (user === undefined) return denied();
    const secret = user.totpPending;
    if (secret === undefined || !acceptTotp(user, secret, code, this.clock.now())) {
      return { ok: false, kind: "invalid_code" };
    }
    user.totpSecret = secret;
    delete user.totpPending;
    return { ok: true, value: true };
  }

  async setPreference(accessToken: string, enabled: boolean): Promise<IdpResult<true>> {
    this.calls.push(`setPreference:${String(enabled)}`);
    const user = userOfToken(accessToken);
    if (user === undefined) return denied();
    if (enabled && user.totpSecret === undefined) return { ok: false, kind: "invalid_code" };
    user.totpEnabled = enabled;
    return { ok: true, value: true };
  }
}

/** The one fake authenticator port of the process (runtime.ts, fakes only). */
export function getDevTotp(): TotpPort {
  const holder = globalThis as unknown as Record<string, TotpPort | undefined>;
  holder["__tcDevTotp"] ??= new FakeTotp();
  return holder["__tcDevTotp"];
}
