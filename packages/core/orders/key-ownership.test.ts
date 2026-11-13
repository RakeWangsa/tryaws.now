import { createHash, randomUUID } from "node:crypto";
import { insertRow, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { makeKit, snapshotRows, type Buyer, type Kit } from "../test/orders-kit";
import { createDraft } from "./draft";
import { draftHash } from "./ids";
import { makeOrders } from "./place";
import { runPurchase } from "./purchase";
import { signDraft, verifyDraft } from "./token";
import type { DraftClaims } from "./types";

// Defect 1 of the review: a keyPairId is accepted only if the key belongs to the session customer.
// The draft and the purchase both check it, and a refusal writes nothing.
const t = useTempDatabase();

/** WPU-Y5 (e): an ssh-rsa line of 2048 bits (e 65537, a modulus from the seed): the only kind a server takes. */
function rsaLine(seed: string): string {
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

async function keyOf(customerId: string, publicKey = rsaLine(uniqueSuffix())): Promise<string> {
  return insertRow(t.pool, "ssh_keys", {
    customer_id: customerId,
    name: "laptop",
    public_key: publicKey,
    fingerprint: "SHA256:key-" + uniqueSuffix(),
  });
}
// A key stored before WPU-Y5 (e): Ed25519, which Lightsail ImportKeyPair does not take.
const ED25519 = () => "ssh-ed25519 AAAAkey" + uniqueSuffix();

/** A token of the buyer whose configuration names `keyPairId`, signed like a real draft. */
async function tokenNaming(kit: Kit, buyer: Buyer, keyPairId: string): Promise<string> {
  const { token } = await kit.draft({}, buyer);
  const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
  if (!verdict.ok) throw new Error("the draft does not verify");
  const claims: DraftClaims = { ...verdict.claims, cfg: { ...verdict.claims.cfg, keyPairId } };
  return signDraft(kit.secrets, claims);
}

const purchase = (kit: Kit, buyer: Buyer, token: string) => {
  const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
  if (!verdict.ok) throw new Error("the token does not verify");
  return kit.run((tx) =>
    runPurchase(tx, kit.deps, {
      claims: verdict.claims,
      tokenHash: draftHash(token),
      clientKey: "key-own-" + "a".repeat(16),
      customerId: buyer.customerId,
    }),
  );
};

describe("createOrderDraft: the key pair must be the customer's", () => {
  it("refuses another customer's key with keyPairId invalid and writes nothing", async () => {
    const kit = await makeKit(t);
    const other = await kit.newBuyer();
    const foreign = await keyOf(other.customerId);
    const before = await snapshotRows(t);
    const r = await createDraft(kit.deps, kit.session, kit.input({ keyPairId: foreign }));
    expect(r).toEqual({ ok: false, error: "validation", fields: { keyPairId: "invalid" } });
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("refuses a key id that does not exist", async () => {
    const kit = await makeKit(t);
    const r = await createDraft(kit.deps, kit.session, kit.input({ keyPairId: randomUUID() }));
    expect(r).toEqual({ ok: false, error: "validation", fields: { keyPairId: "invalid" } });
  });

  it("WPU-Y5: refuses the customer's own key when ImportKeyPair cannot take it (not ssh-rsa 2048+), writing nothing", async () => {
    const kit = await makeKit(t);
    const own = await keyOf(kit.customerId, ED25519());
    const before = await snapshotRows(t);
    const r = await createDraft(kit.deps, kit.session, kit.input({ keyPairId: own }));
    expect(r).toEqual({ ok: false, error: "validation", fields: { keyPairId: "invalid" } });
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("accepts the customer's own key", async () => {
    const kit = await makeKit(t);
    const own = await keyOf(kit.customerId);
    const r = await createDraft(kit.deps, kit.session, kit.input({ keyPairId: own }));
    expect(r.ok).toBe(true);
  });
});

describe("runPurchase: the key pair is checked again, before any write", () => {
  it("refuses a token that names another customer's key and changes no row", async () => {
    const kit = await makeKit(t);
    const other = await kit.newBuyer();
    const foreign = await keyOf(other.customerId);
    const token = await tokenNaming(kit, kit, foreign);
    const before = await snapshotRows(t);
    expect(await purchase(kit, kit, token)).toEqual({
      ok: false,
      error: "validation",
      fields: { keyPairId: "invalid" },
    });
    expect(await snapshotRows(t)).toEqual(before);
    expect(kit.queue.depth).toBe(0);
  });

  it("refuses the same token through placeOrder, with no resource created", async () => {
    const kit = await makeKit(t);
    const other = await kit.newBuyer();
    const foreign = await keyOf(other.customerId);
    const token = await tokenNaming(kit, kit, foreign);
    const before = await snapshotRows(t);
    const r = await makeOrders(kit.deps).placeOrder(kit.session, {
      token,
      idempotencyKey: "key-own-" + "b".repeat(16),
    });
    expect(r).toEqual({ ok: false, error: "validation", fields: { keyPairId: "invalid" } });
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("WPU-Y5: refuses a token that names the customer's own Ed25519 key, before any charge", async () => {
    const kit = await makeKit(t);
    const own = await keyOf(kit.customerId, ED25519());
    const token = await tokenNaming(kit, kit, own);
    const before = await snapshotRows(t);
    expect(await purchase(kit, kit, token)).toEqual({
      ok: false,
      error: "validation",
      fields: { keyPairId: "invalid" },
    });
    expect(await snapshotRows(t)).toEqual(before);
    expect(kit.queue.depth).toBe(0);
  });

  it("buys with the customer's own key and stores it in the configuration", async () => {
    const kit = await makeKit(t);
    const own = await keyOf(kit.customerId);
    const token = await tokenNaming(kit, kit, own);
    const r = await purchase(kit, kit, token);
    expect(r.ok).toBe(true);
    const stored = await t.pool.query(
      "select config->>'keyPairId' as k from resources where customer_id = $1",
      [kit.customerId],
    );
    expect(stored.rows).toEqual([{ k: own }]);
  });
});
