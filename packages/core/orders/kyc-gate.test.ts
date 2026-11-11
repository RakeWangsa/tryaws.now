import { useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { GATE_CASES } from "../test/orders-gate-cases";
import { makeKit, snapshotRows } from "../test/orders-kit";
import { draftHash } from "./ids";
import { makeOrders } from "./place";
import { runPurchase } from "./purchase";
import { verifyDraft } from "./token";

// The third proof of WP4-T4: an order from a customer who is not `verified` creates no resource. The
// ten tables are compared as full rows before and after, not as counts.
const t = useTempDatabase();

describe("runPurchase: the customer gate reads the row, and a refusal writes nothing", () => {
  for (const gate of GATE_CASES) {
    it(`${gate.name}: ${gate.expected}, with every row of ten tables unchanged`, async () => {
      const kit = await makeKit(t);
      const { token, customerId } = await gate.prepare(kit);
      const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
      if (!verdict.ok) throw new Error("the prepared token does not verify");
      const before = await snapshotRows(t);
      const run = () =>
        kit.run((tx) =>
          runPurchase(tx, kit.deps, {
            claims: verdict.claims,
            tokenHash: draftHash(token),
            clientKey: "gate-key-" + "a".repeat(16),
            customerId,
          }),
        );
      if (gate.expected === "throws") {
        await expect(run()).rejects.toThrow();
      } else {
        expect(await run()).toMatchObject({ ok: false, error: gate.expected });
      }
      expect(await snapshotRows(t)).toEqual(before);
      expect(kit.queue.depth).toBe(0);
    });
  }
});

describe("placeOrder: the same table, through the whole order of work", () => {
  for (const gate of GATE_CASES) {
    it(`${gate.name}: ${gate.expected}, with every row of ten tables unchanged`, async () => {
      const kit = await makeKit(t);
      const { session, token } = await gate.prepare(kit);
      const before = await snapshotRows(t);
      const place = () =>
        makeOrders(kit.deps).placeOrder(session, {
          token,
          idempotencyKey: "gate-key-" + "b".repeat(16),
        });
      if (gate.expected === "throws") {
        await expect(place()).rejects.toThrow();
      } else {
        expect(await place()).toMatchObject({ ok: false, error: gate.expected });
      }
      expect(await snapshotRows(t)).toEqual(before);
      expect(kit.queue.depth).toBe(0);
    });
  }
});
