import type { CustomerSession } from "@tc/auth";
import type { AuditRepo, CustomerLimit, RateLimitsRepo } from "@tc/db";
import { parseSupportRequest, type SupportRequestInput } from "./support-request.ts";

// The core of createSupportRequest (16.10 /support, WP9-T4). R9 order: authenticate, authorize (a
// signed-in customer; no other role exists on this side), validate, rate limit, execute, audit.
// The ports are parameters, so the core runs in a test without a database.
//
// NEEDS DECISION (JOURNEY.md, WP9-T4): packages/db has no customer repository that inserts into
// support_requests (web_rw holds the INSERT grant in 0006_roles_and_grants.sql, but only the admin
// side reads the table). The write is therefore a port, `SupportWriter`; the real implementation
// (`customerRepos(...).support.create`) is a separate task in packages/db. No page uses this core yet.

export interface SupportWriter {
  /** Inserts one row; the id is derived from (customer, idempotencyKey), so a replay is a no-op (R7). */
  create(
    input: SupportRequestInput,
  ): Promise<{ ok: true; id: string; replayed: boolean } | { ok: false; error: string }>;
}

export interface SupportRepos {
  support: SupportWriter;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
}

export interface SupportActionDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: SupportRepos) => Promise<T>): Promise<T>;
}

export type SupportError = "unauthenticated" | "validation" | "rate_limited" | "unavailable";
export type SupportResult =
  | { ok: true; id: string; replayed: boolean }
  | { ok: false; error: SupportError; fields?: Record<string, string> };

export const SUPPORT_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "support.create", limit: 5, windowSeconds: 3600 }),
]);

export async function createSupportRequestCore(
  deps: SupportActionDeps,
  raw: unknown,
): Promise<SupportResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const parsed = parseSupportRequest(raw);
  if (!parsed.ok) return { ok: false, error: "validation", fields: parsed.fields };

  try {
    return await deps.store(session.customerId, async (repos): Promise<SupportResult> => {
      const limit = await repos.rateLimits.consume(SUPPORT_LIMITS, deps.now());
      if (!limit.allowed) return { ok: false, error: "rate_limited" };

      const written = await repos.support.create(parsed.value);
      if (!written.ok) return { ok: false, error: "unavailable" };
      // A replay changed nothing, so it audits nothing. The audit row holds the id, never the text (R14).
      if (!written.replayed) {
        const audited = await repos.audit.record({
          action: "support.create",
          targetType: "support_request",
          targetId: written.id,
        });
        if (!audited.ok) throw new Error("support: the audit entry was refused");
      }
      return { ok: true, id: written.id, replayed: written.replayed };
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
