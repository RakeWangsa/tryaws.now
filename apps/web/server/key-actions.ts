import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import type { AuditRepo, CustomerLimit, RateLimitsRepo, SshKeysRepo } from "@tc/db";
import { parseSshKeyInput } from "./ssh-key.ts";

// The cores of the SSH key actions (/settings/ssh-keys). R9 order in each: authenticate, authorize
// (a fresh sign-in for a removal, U10), validate, rate limit, execute, audit. The ports are
// parameters, so the cores run in a test without a database. Only public keys are handled; the
// audit entry holds the key id, never the key text.

export interface KeyRepos {
  sshKeys: SshKeysRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
}

export interface KeyActionDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: KeyRepos) => Promise<T>): Promise<T>;
}

export type KeyError =
  | "unauthenticated"
  | "fresh_sign_in_required"
  | "validation"
  | "rate_limited"
  | "conflict"
  | "not_found"
  | "name_mismatch"
  | "unavailable";

export type AddKeyResult =
  | { ok: true; id: string; replayed: boolean }
  | { ok: false; error: KeyError; fields?: Record<string, string> };
export type RemoveKeyResult =
  { ok: true; id: string } | { ok: false; error: KeyError; fields?: Record<string, string> };

const KEY_WRITE_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "ssh_key.write", limit: 20, windowSeconds: 3600 }),
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function addSshKeyCore(deps: KeyActionDeps, raw: unknown): Promise<AddKeyResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const parsed = parseSshKeyInput(raw);
  if (!parsed.ok)
    return { ok: false, error: "validation", ...(parsed.fields ? { fields: parsed.fields } : {}) };

  try {
    return await deps.store(session.customerId, async (repos): Promise<AddKeyResult> => {
      const limit = await repos.rateLimits.consume(KEY_WRITE_LIMITS, deps.now());
      if (!limit.allowed) return { ok: false, error: "rate_limited" };

      const added = await repos.sshKeys.add(parsed.value);
      if (!added.ok) {
        return { ok: false, error: added.error === "conflict" ? "conflict" : "unavailable" };
      }
      // A replay changed nothing, so it audits nothing.
      if (!added.replayed) {
        const audited = await repos.audit.record({
          action: "ssh_key.add",
          targetType: "ssh_key",
          targetId: added.value.id,
        });
        if (!audited.ok) throw new Error("ssh keys: the audit entry was refused");
      }
      return { ok: true, id: added.value.id, replayed: added.replayed };
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export async function removeSshKeyCore(
  deps: KeyActionDeps,
  raw: unknown,
): Promise<RemoveKeyResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };
  const fresh = requireFreshSignIn(session, { now: deps.now });
  if (!fresh.ok) return { ok: false, error: "fresh_sign_in_required" };

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = input["id"];
  const confirmName = input["confirmName"];
  if (typeof id !== "string" || !UUID.test(id)) {
    return { ok: false, error: "validation", fields: { id: "invalid" } };
  }
  if (typeof confirmName !== "string") {
    return { ok: false, error: "validation", fields: { confirmName: "invalid" } };
  }

  try {
    return await deps.store(session.customerId, async (repos): Promise<RemoveKeyResult> => {
      const key = await repos.sshKeys.get(id);
      if (key === null) return { ok: false, error: "not_found" };
      // U10: the customer typed the name of the key, exactly.
      if (confirmName !== key.name) return { ok: false, error: "name_mismatch" };

      const limit = await repos.rateLimits.consume(KEY_WRITE_LIMITS, deps.now());
      if (!limit.allowed) return { ok: false, error: "rate_limited" };

      const removed = await repos.sshKeys.remove(id);
      if (!removed.ok)
        return { ok: false, error: removed.error === "not_found" ? "not_found" : "unavailable" };
      const audited = await repos.audit.record({
        action: "ssh_key.remove",
        targetType: "ssh_key",
        targetId: id,
      });
      if (!audited.ok) throw new Error("ssh keys: the audit entry was refused");
      return { ok: true, id };
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
