import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../flags";
import { childId } from "./ids";
import { purchaseSubscription } from "./purchase";

// WPU-Z2 (owner decision of 2026-11-13): every purchase opens its subscription with auto-renew ON. No
// database here: runPurchase passes this input to createSubscription as it is. The stored row is read by
// the database tests purchase.test.ts, domain-purchase.test.ts and dns-zone-order.test.ts.

const ORDER = "0190aaaa-0000-7000-8000-0000000000a1";
const RESOURCE = childId(ORDER, "resource");
const NOW = new Date("2026-11-13T06:00:00.000Z");
const SNAPSHOT = { v: 1, currency: "BDT", totalMinor: "74295" };
const DAY_MS = 86_400_000;

describe("purchaseSubscription (WPU-Z2)", () => {
  it("covers the twelve product families", () => {
    expect(FEATURE_FLAGS).toHaveLength(12);
  });

  it.each(FEATURE_FLAGS.map((family) => [family]))(
    "%s: auto-renew is on, for the term of the family from the purchase",
    (family) => {
      const termDays = family === "domain" ? 365 : 30;
      expect(
        purchaseSubscription({
          orderId: ORDER,
          resourceId: RESOURCE,
          family,
          priceSnapshot: SNAPSHOT,
          now: NOW,
        }),
      ).toEqual({
        id: childId(ORDER, "subscription"),
        resourceId: RESOURCE,
        termDays,
        priceSnapshot: SNAPSHOT,
        periodStart: NOW,
        periodEnd: new Date(NOW.getTime() + termDays * DAY_MS),
        autoRenew: true,
      });
    },
  );
});
