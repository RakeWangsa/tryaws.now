import { isValidSignInShape, parseViewerAddress } from "@tc/auth";
import type { AdminSignInInput, AdminSignInOutcome } from "@tc/auth";
import type { AdminAccessEntry } from "@tc/db";

// The sign-in of the operator app in the order of R9: authorize (the allowlist), validate, rate limit,
// execute, audit. No next/* import here: the Server Action in actions.ts wires the real pieces and sets
// the cookie, so every step is tested with fakes.

export interface SignInRequest {
  readonly email: unknown;
  readonly password: unknown;
  readonly code: unknown;
  readonly viewerAddress: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

export type SignInAnswer =
  | { readonly ok: true; readonly accessToken: string; readonly maxAgeSeconds: number }
  | { readonly ok: false; readonly code: "invalid" | "denied" | "unavailable" | "rate_limited" };

export interface SignInDeps {
  // adminGate with the environment: false outside the allowlist.
  readonly allowed: (viewerAddress: string | null | undefined) => boolean;
  readonly signIn: (input: AdminSignInInput) => Promise<AdminSignInOutcome>;
  // True when the hit was counted, false over the limit (consumeRateLimits, per address).
  readonly limiter: (ip: string, now: Date) => Promise<boolean>;
  readonly audit: (entry: Omit<AdminAccessEntry, "action">) => Promise<void>;
  readonly clock: { now(): Date };
}

export function makeSignIn(deps: SignInDeps): (request: SignInRequest) => Promise<SignInAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const { email, password, code, viewerAddress, userAgent } = request;

    // 1. Authorize: outside the allowlist nothing is done, not even a database write.
    if (!deps.allowed(viewerAddress)) return { ok: false, code: "denied" };
    const ip = parseViewerAddress(viewerAddress);
    if (ip === null) return { ok: false, code: "denied" };
    const agent = typeof userAgent === "string" && userAgent !== "" ? { userAgent } : {};
    const note = (outcome: AdminAccessEntry["outcome"], adminId: string | null = null) =>
      deps.audit({ adminId, ip, ...agent, outcome });

    try {
      // 2. Validate.
      if (!isValidSignInShape({ email, password, code })) {
        await note("invalid");
        return { ok: false, code: "invalid" };
      }
      const now = deps.clock.now();

      // 3. Rate limit, before Cognito is asked.
      if (!(await deps.limiter(ip, now))) {
        await note("rate_limited");
        return { ok: false, code: "rate_limited" };
      }

      // 4. Execute.
      const outcome = await deps.signIn({
        email: email as string,
        password: password as string,
        code: code as string,
        viewerAddress,
      });
      if (!outcome.ok) {
        await note(outcome.reason === "unavailable" ? "unavailable" : "denied");
        return {
          ok: false,
          code: outcome.reason === "unavailable" ? "unavailable" : "denied",
        };
      }
      const maxAgeSeconds = Math.floor((outcome.expiresAt.getTime() - now.getTime()) / 1000);
      if (!(maxAgeSeconds > 0)) {
        await note("denied");
        return { ok: false, code: "denied" };
      }

      // 5. Audit. Fails closed (R16): no row, no session.
      await note("ok", outcome.adminId);
      return { ok: true, accessToken: outcome.accessToken, maxAgeSeconds };
    } catch {
      // The text of a thrown error may hold a password or a token (R14): none is kept.
      return { ok: false, code: "unavailable" };
    }
  };
}

export function makeSignOut(deps: {
  readonly audit: SignInDeps["audit"];
}): (actor: { adminId: string; ip: string; userAgent?: string | undefined }) => Promise<void> {
  return async (actor) => {
    try {
      await deps.audit({
        adminId: actor.adminId,
        ip: actor.ip,
        ...(actor.userAgent !== undefined ? { userAgent: actor.userAgent } : {}),
        outcome: "ok",
      });
    } catch {
      // The cookie is cleared by the caller whatever happens here: signing out never fails.
    }
  };
}
