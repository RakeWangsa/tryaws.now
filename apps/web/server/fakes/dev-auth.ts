import type { AccessTokenVerifier, TokenOutcome } from "@tc/auth";

// Development and test only (see eps-bridge.ts): accepts the token `dev.<sub>` and nothing else.
// A real Cognito access token is a JWT and never has this form; the production runtime does not
// load this file at all.
const DEV_TOKEN = /^dev\.([A-Za-z0-9_-]{1,64})$/;
const ONE_HOUR_MS = 3_600_000;

export const devVerifier: AccessTokenVerifier = {
  async verify(token: string | undefined): Promise<TokenOutcome> {
    const match = typeof token === "string" ? DEV_TOKEN.exec(token) : null;
    if (match === null) {
      return { ok: false, error: "unauthenticated", reason: "token_invalid" };
    }
    const now = Date.now();
    return {
      ok: true,
      token: {
        sub: match[1] as string,
        issuedAt: new Date(now),
        authTime: new Date(now),
        expiresAt: new Date(now + ONE_HOUR_MS),
      },
    };
  },
};
