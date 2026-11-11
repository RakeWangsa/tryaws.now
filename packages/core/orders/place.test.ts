import { randomUUID } from "node:crypto";
import { useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { makeKit, PLAN_TOTAL, SECRET_B, snapshotRows, type Kit } from "../test/orders-kit";
import { makeOrders } from "./place";
import { signDraft, verifyDraft } from "./token";

const t = useTempDatabase();

const newKey = () => "k" + randomUUID().replaceAll("-", "");
const place = (kit: Kit, token: string, idempotencyKey = newKey(), session = kit.session) =>
  makeOrders(kit.deps).placeOrder(session, { token, idempotencyKey });

describe("makeOrders", () => {
  it("throws a TypeError at construction for an empty list and for a key under 32 bytes", async () => {
    const kit = await makeKit(t);
    expect(() => makeOrders({ ...kit.deps, secrets: [] })).toThrow(TypeError);
    expect(() => makeOrders({ ...kit.deps, secrets: [new Uint8Array(31)] })).toThrow(TypeError);
  });

  it("createOrderDraft is the draft of Task 5 behind the same factory", async () => {
    const kit = await makeKit(t);
    const r = await makeOrders(kit.deps).createOrderDraft(kit.session, kit.input());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.quote.totalMinor).toBe(PLAN_TOTAL);
  });
});

describe("placeOrder: authorize and validate before any query", () => {
  it("a token of customer A used by customer B is forbidden and writes nothing (R8)", async () => {
    const kit = await makeKit(t);
    const b = await kit.newBuyer();
    const { token } = await kit.draft();
    const before = await snapshotRows(t);
    expect(await place(kit, token, newKey(), b.session)).toEqual({ ok: false, error: "forbidden" });
    expect(await snapshotRows(t)).toEqual(before);
    expect(await kit.balance(b.customerId)).toBe(10_000_000n);
    expect(kit.queue.depth).toBe(0);
  });

  it("a tampered token, a token of an unknown signer and an expired token are validation", async () => {
    const kit = await makeKit(t);
    const { token } = await kit.draft();
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(await place(kit, tampered)).toMatchObject({
      ok: false,
      error: "validation",
      fields: { token: "invalid" },
    });
    const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
    if (!verdict.ok) throw new Error("the draft does not verify");
    const foreign = signDraft([SECRET_B], verdict.claims);
    expect(await place(kit, foreign)).toMatchObject({
      ok: false,
      error: "validation",
      fields: { token: "invalid" },
    });
    expect(await place(kit, "not.a.token")).toMatchObject({ ok: false, error: "validation" });
    kit.clock.advance(31 * 60);
    expect(await place(kit, token)).toMatchObject({
      ok: false,
      error: "validation",
      fields: { token: "expired" },
    });
    expect(await kit.balance()).toBe(10_000_000n);
  });

  it("a client key of 15 characters, or with a bad character, is validation", async () => {
    const kit = await makeKit(t);
    const { token } = await kit.draft();
    for (const key of ["a".repeat(15), "a".repeat(16) + "!", "a".repeat(65), ""]) {
      expect(await place(kit, token, key)).toMatchObject({
        ok: false,
        error: "validation",
        fields: { idempotencyKey: "invalid" },
      });
    }
    expect(kit.queue.depth).toBe(0);
  });

  it("a body that is not an object is validation", async () => {
    const kit = await makeKit(t);
    const orders = makeOrders(kit.deps);
    for (const bad of [null, undefined, "x", 7]) {
      expect(
        await orders.placeOrder(
          kit.session,
          bad as unknown as { token: string; idempotencyKey: string },
        ),
      ).toMatchObject({ ok: false, error: "validation" });
    }
  });
});

describe("placeOrder: the price changed", () => {
  it("returns a new draft that verifies at the new price; the new token buys, the old one stays price_changed", async () => {
    const kit = await makeKit(t);
    const old = await kit.draft();
    await kit.changeFxRate("130");
    const before = await snapshotRows(t);
    const refused = await place(kit, old.token);
    expect(refused).toMatchObject({ ok: false, error: "price_changed" });
    if (refused.ok) return;
    const data = refused.data as { token: string; quote: { totalMinor: bigint }; expiresAt: Date };
    expect(await snapshotRows(t)).toEqual(before);
    const verdict = verifyDraft(kit.secrets, data.token, kit.clock.now());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.claims.snap.fxRate).toBe("130");
    expect(BigInt(verdict.claims.snap.totalMinor)).toBe(data.quote.totalMinor);
    expect(data.quote.totalMinor).not.toBe(PLAN_TOTAL);
    expect(data.expiresAt).toEqual(new Date(verdict.claims.exp * 1000));
    // the old token again, while the rate stays: still price_changed
    expect(await place(kit, old.token)).toMatchObject({ ok: false, error: "price_changed" });
    // the new token buys, at the new price
    const start = await kit.balance();
    expect((await place(kit, data.token)).ok).toBe(true);
    expect(await kit.balance()).toBe(start - data.quote.totalMinor);
  });
});

describe("placeOrder: the rate limit", () => {
  it("allows ten calls a minute and trips at the eleventh", async () => {
    const kit = await makeKit(t);
    const { token } = await kit.draft();
    const results = [];
    for (let i = 0; i < 11; i += 1) results.push(await place(kit, token));
    expect(results.slice(0, 10).every((r) => r.ok)).toBe(true);
    expect(results[10]).toMatchObject({ ok: false, error: "rate_limited" });
    const data = (results[10] as { data: { retryAfterSeconds: number } }).data;
    expect(data.retryAfterSeconds).toBeGreaterThan(0);
    expect(data.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe("placeOrder: nothing it says holds the token or the client key (R14)", () => {
  it("results, logs and thrown texts hold neither", async () => {
    const logs: unknown[] = [];
    const kit = await makeKit(t);
    const deps = { ...kit.deps, log: (event: unknown) => void logs.push(event) };
    const orders = makeOrders(deps);
    kit.queue.failNextSends(1);
    const { token } = await kit.draft();
    const key = newKey();
    const seen: string[] = [];
    seen.push(JSON.stringify(await orders.placeOrder(kit.session, { token, idempotencyKey: key })));
    seen.push(JSON.stringify(await orders.placeOrder(kit.session, { token, idempotencyKey: "x" })));
    seen.push(
      JSON.stringify(await orders.placeOrder(kit.session, { token: "t.t", idempotencyKey: key })),
    );
    const ghost = { ...kit.session, customerId: randomUUID() };
    const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
    if (!verdict.ok) throw new Error("the draft does not verify");
    const ghostToken = signDraft(kit.secrets, { ...verdict.claims, c: ghost.customerId });
    const thrown = await orders.placeOrder(ghost, { token: ghostToken, idempotencyKey: key }).then(
      () => "no error",
      (e: Error) => e.message,
    );
    seen.push(thrown, JSON.stringify(logs));
    for (const text of seen) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(ghostToken);
      expect(text).not.toContain(key);
    }
  });
});
