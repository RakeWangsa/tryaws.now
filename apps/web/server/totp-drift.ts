import type { AuditRepo, ProfileRepo } from "@tc/db";

// WPU-X11 round 2 (security review, finding 2). The platform keeps a copy of "the authenticator is on"
// (customers.totp_enabled_at) because the purchase code cannot call Cognito, and Cognito holds the real
// setting. It can be switched off outside the panel: with the customer's own access token on the public
// endpoint, with a stolen token, or by support. Two places see the truth and call this function:
//   - the sign-in: the tokens came without the authenticator challenge although the copy says on;
//   - the draft and purchase check (mfa-gate.ts): GetUser does not list the software token.
// It clears the copy, writes the audit row `auth.totp_drift` (the way it was seen, never a secret or a
// code), and tells the customer. A refused write or notice throws, so the caller's transaction rolls
// everything back and the attempt is refused (R16). Run inside one customer-scoped transaction (R8).

export type DriftVia = "sign_in" | "purchase_check";

export interface DriftRepos {
  readonly profile: Pick<ProfileRepo, "get" | "setTotpEnabled">;
  readonly audit: Pick<AuditRepo, "record">;
}

/** True when the copy was cleared now; false when there was nothing to clear. */
export async function clearTotpDrift(
  repos: DriftRepos,
  input: { via: DriftVia; at: Date; notify: (at: Date) => Promise<void> },
): Promise<boolean> {
  const profile = await repos.profile.get();
  if (profile === null) throw new Error("totp drift: no customer row");
  if (profile.totpEnabledAt === null) return false;
  const cleared = await repos.profile.setTotpEnabled(null);
  if (!cleared.ok) throw new Error("totp drift: the copy could not be cleared");
  const written = await repos.audit.record({
    action: "auth.totp_drift",
    targetType: "customer",
    metadata: { via: input.via },
  });
  if (!written.ok) throw new Error("totp drift: the audit entry was refused");
  await input.notify(input.at);
  return true;
}
