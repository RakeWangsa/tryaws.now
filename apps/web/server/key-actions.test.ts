import { createHash } from "node:crypto";
import type { CustomerSession } from "@tc/auth";
import type { AuditRepo, RateLimitsRepo, SshKey, SshKeysRepo } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  addSshKeyCore,
  removeSshKeyCore,
  type KeyActionDeps,
  type KeyRepos,
} from "./key-actions.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const ID = "0190aaaa-0000-7000-8000-000000000001";
const session = (signedInAt: Date): CustomerSession => ({
  customerId: "11111111-1111-4111-8111-111111111111",
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});

function blobKey(): string {
  const type = Buffer.from("ssh-ed25519");
  const raw = createHash("sha256").update("k").digest();
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    type,
    Buffer.from([0, 0, 0, raw.length]),
    raw,
  ]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

function world(
  over: {
    allowed?: boolean;
    existing?: SshKey | null;
    add?: "created" | "replayed" | "conflict";
  } = {},
) {
  const calls: string[] = [];
  const existing: SshKey | null =
    over.existing === undefined
      ? { id: ID, name: "Laptop", publicKey: blobKey(), fingerprint: "SHA256:x", createdAt: NOW }
      : over.existing;
  const repos: KeyRepos = {
    sshKeys: {
      list: async () => [],
      get: async () => existing,
      add: async (input) => {
        calls.push(`add:${input.name}`);
        if (over.add === "conflict") return { ok: false, error: "conflict" };
        return {
          ok: true,
          replayed: over.add === "replayed",
          value: { id: ID, ...input, createdAt: NOW },
        };
      },
      remove: async () => {
        calls.push("remove");
        return { ok: true, replayed: false, value: { id: ID } };
      },
    } satisfies SshKeysRepo,
    audit: {
      record: async (input) => {
        calls.push(`audit:${input.action}`);
        return { ok: true, replayed: false, value: { id: "a" } };
      },
    } satisfies AuditRepo,
    rateLimits: {
      consume: async () => {
        calls.push("rateLimit");
        return over.allowed === false
          ? { allowed: false, action: "ssh_key.write", retryAfterSeconds: 5 }
          : { allowed: true };
      },
    } satisfies RateLimitsRepo,
  };
  let current: CustomerSession | null = session(new Date(NOW.getTime() - 60_000));
  const deps: KeyActionDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return current;
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      expect(customerId).toBe("11111111-1111-4111-8111-111111111111");
      return fn(repos);
    },
  };
  return {
    deps,
    calls,
    setSession: (s: CustomerSession | null) => {
      current = s;
    },
  };
}

describe("addSshKeyCore", () => {
  it("authenticates, validates, rate limits, writes and audits, in that order", async () => {
    const w = world();
    const result = await addSshKeyCore(w.deps, { name: "Laptop", publicKey: blobKey() });
    expect(result).toEqual({ ok: true, id: ID, replayed: false });
    expect(w.calls).toEqual(["authenticate", "rateLimit", "add:Laptop", "audit:ssh_key.add"]);
  });

  it("refuses an invalid key before the database", async () => {
    const w = world();
    const result = await addSshKeyCore(w.deps, { name: "Laptop", publicKey: "nope" });
    expect(result).toEqual({ ok: false, error: "validation", fields: { publicKey: "invalid" } });
    expect(w.calls).toEqual(["authenticate"]);
  });

  it("refuses without a session", async () => {
    const w = world();
    w.setSession(null);
    expect(await addSshKeyCore(w.deps, { name: "L", publicKey: blobKey() })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });

  it("answers rate_limited and writes nothing", async () => {
    const w = world({ allowed: false });
    expect(await addSshKeyCore(w.deps, { name: "L", publicKey: blobKey() })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(w.calls).toEqual(["authenticate", "rateLimit"]);
  });

  it("is idempotent: the same key again is a success marked as replayed, with no second audit row", async () => {
    const w = world({ add: "replayed" });
    const result = await addSshKeyCore(w.deps, { name: "L", publicKey: blobKey() });
    expect(result).toEqual({ ok: true, id: ID, replayed: true });
    expect(w.calls).not.toContain("audit:ssh_key.add");
  });

  it("maps a fingerprint taken by another name to conflict", async () => {
    const w = world({ add: "conflict" });
    expect(await addSshKeyCore(w.deps, { name: "L", publicKey: blobKey() })).toEqual({
      ok: false,
      error: "conflict",
    });
  });
});

describe("removeSshKeyCore", () => {
  it("needs a fresh sign-in (U10, 6.1)", async () => {
    const w = world();
    w.setSession(session(new Date(NOW.getTime() - 3_600_000)));
    expect(await removeSshKeyCore(w.deps, { id: ID, confirmName: "Laptop" })).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(w.calls).toEqual(["authenticate"]);
  });

  it("needs the typed name, exactly", async () => {
    const w = world();
    expect(await removeSshKeyCore(w.deps, { id: ID, confirmName: "laptop" })).toEqual({
      ok: false,
      error: "name_mismatch",
    });
    expect(w.calls).not.toContain("remove");
  });

  it("removes, then audits", async () => {
    const w = world();
    expect(await removeSshKeyCore(w.deps, { id: ID, confirmName: "Laptop" })).toEqual({
      ok: true,
      id: ID,
    });
    expect(w.calls).toEqual(["authenticate", "rateLimit", "remove", "audit:ssh_key.remove"]);
  });

  it("answers not_found for a key that is not the customer's own", async () => {
    const w = world({ existing: null });
    expect(await removeSshKeyCore(w.deps, { id: ID, confirmName: "Laptop" })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("refuses an id that is not a UUID", async () => {
    const w = world();
    expect(await removeSshKeyCore(w.deps, { id: "1 or 1=1", confirmName: "x" })).toEqual({
      ok: false,
      error: "validation",
      fields: { id: "invalid" },
    });
  });
});
