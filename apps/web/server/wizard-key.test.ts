import { createHash } from "node:crypto";
import type { OrderDraft, OrderSession } from "@tc/core";
import type { SshKey } from "@tc/db";
import { describe, expect, it } from "vitest";
import type { KeyActionDeps, KeyRepos } from "./key-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";
import { createServerDraftCore } from "./wizard-key.ts";

// WPU-G10. The create wizard can take a key in three ways, as the Lightsail console does: an existing key,
// a pair the browser made, or a public key the customer pastes. The last two store the PUBLIC key through
// the same tenant-scoped repository as /settings/ssh-keys and then continue with its id. The private key
// never reaches the server: it is not a field of the form, and a private key in the public field is refused.
const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SESSION: OrderSession = {
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
};
const PRODUCT = "0190aaaa-0000-7000-8000-000000000001";
const OLD_KEY = "0190aaaa-0000-7000-8000-0000000000c1";
const NEW_KEY = "0190aaaa-0000-7000-8000-0000000000c2";

function publicLine(seed = "k"): string {
  // WPU-Y5 (e): an OpenSSH ssh-rsa line (ImportKeyPair takes ssh-rsa only): e 65537 and a 2048 bit modulus
  // made from the seed. The parser checks the form and the size, not the arithmetic.
  const field = (b: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(b.length);
    return Buffer.concat([head, b]);
  };
  const n = Buffer.concat(
    Array.from({ length: 8 }, (_, i) => createHash("sha256").update(`${seed}:${i}`).digest()),
  );
  n[0] = (n[0] ?? 0) | 0x80;
  const blob = Buffer.concat([
    field(Buffer.from("ssh-rsa")),
    field(Buffer.from([1, 0, 1])),
    field(Buffer.concat([Buffer.from([0]), n])),
  ]);
  return `ssh-rsa ${blob.toString("base64")}`;
}

const DRAFT: OrderDraft = {
  token: "tok.en",
  quote: {
    currency: "BDT",
    fxRate: "120.0000",
    ruleVersion: "v1",
    baseMinor: 100000n,
    steps: [],
    totalMinor: 100000n,
  },
  expiresAt: new Date("2026-11-12T10:30:00Z"),
};

function world(
  over: {
    add?: "created" | "replayed" | "conflict" | "down";
    session?: boolean;
    draft?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const orderDeps: OrderActionDeps = {
    authenticate: async () => {
      calls.push("order.authenticate");
      return over.session === false ? null : SESSION;
    },
    rateLimit: async () => {
      calls.push("order.rateLimit");
      return { allowed: true };
    },
    orders: {
      createOrderDraft: async (_s, input) => {
        calls.push("order.draft:" + JSON.stringify(input));
        return over.draft === false
          ? { ok: false, error: "validation", fields: { productId: "plan_too_small" } }
          : { ok: true, value: DRAFT };
      },
      placeOrder: async () => ({ ok: false, error: "internal" }),
    },
  };
  const repos: KeyRepos = {
    sshKeys: {
      list: async () => [],
      get: async () => null,
      add: async (input: { name: string; publicKey: string; fingerprint: string }) => {
        calls.push(`key.add:${input.name}:${input.publicKey.slice(0, 11)}`);
        if (over.add === "down") throw new Error("database down");
        if (over.add === "conflict") return { ok: false, error: "conflict" };
        const value: SshKey = { id: NEW_KEY, ...input, createdAt: NOW };
        return { ok: true, replayed: over.add === "replayed", value };
      },
      remove: async () => ({ ok: true, replayed: false, value: undefined }),
    } as unknown as KeyRepos["sshKeys"],
    audit: {
      record: async (entry: { action: string; targetId: string }) => {
        calls.push(`audit:${entry.action}:${entry.targetId}`);
        return { ok: true };
      },
    } as unknown as KeyRepos["audit"],
    rateLimits: {
      consume: async () => {
        calls.push("key.rateLimit");
        return { allowed: true };
      },
    } as unknown as KeyRepos["rateLimits"],
  };
  const keyDeps: KeyActionDeps = {
    authenticate: async () => {
      calls.push("key.authenticate");
      return over.session === false
        ? null
        : {
            customerId: CUSTOMER,
            kycStatus: "verified",
            riskTier: "new",
            locale: "bn",
            signedInAt: NOW,
          };
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      calls.push("key.store:" + customerId);
      return fn(repos);
    },
  };
  return { orderDeps, keyDeps, calls };
}

const base = {
  productId: PRODUCT,
  region: "ap-south-1",
  displayName: "My server",
  blueprintId: "ubuntu_24_04",
};
const drafted = (calls: string[]): Record<string, unknown> => {
  const line = calls.find((c) => c.startsWith("order.draft:"));
  return JSON.parse((line ?? "order.draft:{}").slice("order.draft:".length)) as Record<
    string,
    unknown
  >;
};

describe("createServerDraftCore", () => {
  it("an existing key (no keyMode, as before) stores nothing and passes the key id on", async () => {
    const w = world();
    const r = await createServerDraftCore(w.orderDeps, w.keyDeps, { ...base, keyPairId: OLD_KEY });
    expect(r).toEqual({ ok: true, token: "tok.en" });
    expect(w.calls.some((c) => c.startsWith("key.add"))).toBe(false);
    expect((drafted(w.calls).config as Record<string, unknown>).keyPairId).toBe(OLD_KEY);
  });

  it.each(["generate", "paste"])(
    "%s: stores the public key through the customer's repository, audits it, and drafts with the new key id",
    async (mode) => {
      const w = world();
      const line = publicLine();
      const r = await createServerDraftCore(w.orderDeps, w.keyDeps, {
        ...base,
        keyMode: mode,
        keyPairId: OLD_KEY, // ignored: the new key wins in this mode
        newKeyName: "laptop",
        newKeyPublic: line,
      });
      expect(r).toEqual({ ok: true, token: "tok.en" });
      // R9 across the two steps: authenticate, then the key (limit, add, audit), then the draft
      expect(w.calls[0]).toBe("key.authenticate");
      expect(w.calls).toContain(`key.store:${CUSTOMER}`); // the customer comes from the session (R8)
      expect(w.calls.indexOf("key.rateLimit")).toBeLessThan(
        w.calls.indexOf(`key.add:laptop:${line.slice(0, 11)}`),
      );
      expect(w.calls).toContain(`audit:ssh_key.add:${NEW_KEY}`);
      expect(w.calls.findIndex((c) => c.startsWith("key.add"))).toBeLessThan(
        w.calls.findIndex((c) => c.startsWith("order.draft")),
      );
      expect((drafted(w.calls).config as Record<string, unknown>).keyPairId).toBe(NEW_KEY);
    },
  );

  it("the same public key again is a replay: the draft continues with the stored key and no second audit row", async () => {
    const w = world({ add: "replayed" });
    const r = await createServerDraftCore(w.orderDeps, w.keyDeps, {
      ...base,
      keyMode: "paste",
      newKeyName: "laptop",
      newKeyPublic: publicLine(),
    });
    expect(r.ok).toBe(true);
    expect(w.calls.some((c) => c.startsWith("audit:"))).toBe(false);
  });

  it("a private key in the public field is refused, never stored, never echoed", async () => {
    const w = world();
    const r = await createServerDraftCore(w.orderDeps, w.keyDeps, {
      ...base,
      keyMode: "paste",
      newKeyName: "laptop",
      newKeyPublic: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    });
    expect(r).toEqual({ ok: false, error: "validation", fields: { newKeyPublic: "invalid" } });
    expect(JSON.stringify(r)).not.toContain("PRIVATE");
    expect(w.calls.some((c) => c.startsWith("key.add") || c.startsWith("order.draft"))).toBe(false);
  });

  it("names the field of the wizard for a bad name or a bad key, and stores nothing", async () => {
    const w = world();
    const r = await createServerDraftCore(w.orderDeps, w.keyDeps, {
      ...base,
      keyMode: "generate",
      newKeyName: "bad/name!",
      newKeyPublic: "not a key",
    });
    expect(r).toEqual({
      ok: false,
      error: "validation",
      fields: { newKeyName: "invalid", newKeyPublic: "invalid" },
    });
    expect(w.calls.some((c) => c.startsWith("key.add"))).toBe(false);
  });

  it("an unknown mode is refused, not read as the existing key (R16)", async () => {
    const w = world();
    const r = await createServerDraftCore(w.orderDeps, w.keyDeps, {
      ...base,
      keyMode: "anything",
      keyPairId: OLD_KEY,
    });
    expect(r).toEqual({ ok: false, error: "validation", fields: { keyMode: "invalid" } });
    expect(w.calls.some((c) => c.startsWith("order.draft"))).toBe(false);
  });

  it("a name that is taken by another key is a field error; a failing store is unavailable", async () => {
    const taken = world({ add: "conflict" });
    expect(
      await createServerDraftCore(taken.orderDeps, taken.keyDeps, {
        ...base,
        keyMode: "paste",
        newKeyName: "laptop",
        newKeyPublic: publicLine(),
      }),
    ).toEqual({ ok: false, error: "validation", fields: { newKeyName: "taken" } });
    const down = world({ add: "down" });
    expect(
      await createServerDraftCore(down.orderDeps, down.keyDeps, {
        ...base,
        keyMode: "paste",
        newKeyName: "laptop",
        newKeyPublic: publicLine(),
      }),
    ).toEqual({ ok: false, error: "unavailable" });
    expect(down.calls.some((c) => c.startsWith("order.draft"))).toBe(false);
  });

  it("without a session nothing runs (R16)", async () => {
    const w = world({ session: false });
    const r = await createServerDraftCore(w.orderDeps, w.keyDeps, {
      ...base,
      keyMode: "paste",
      newKeyName: "laptop",
      newKeyPublic: publicLine(),
    });
    expect(r).toEqual({ ok: false, error: "unauthenticated" });
    expect(w.calls.every((c) => c.endsWith("authenticate"))).toBe(true);
  });

  it("when the order refuses (a plan too small, say) the refusal is passed on as it is", async () => {
    const w = world({ draft: false });
    const r = await createServerDraftCore(w.orderDeps, w.keyDeps, {
      ...base,
      keyMode: "paste",
      newKeyName: "laptop",
      newKeyPublic: publicLine(),
    });
    expect(r).toEqual({ ok: false, error: "validation", fields: { productId: "plan_too_small" } });
  });

  it("the customer id in the form is ignored: the key store and the order use the session", async () => {
    const w = world();
    await createServerDraftCore(w.orderDeps, w.keyDeps, {
      ...base,
      keyMode: "paste",
      newKeyName: "laptop",
      newKeyPublic: publicLine(),
      customerId: "99999999-9999-4999-8999-999999999999",
    });
    expect(w.calls).toContain(`key.store:${CUSTOMER}`);
    expect(w.calls.join("|")).not.toContain("99999999");
  });
});
