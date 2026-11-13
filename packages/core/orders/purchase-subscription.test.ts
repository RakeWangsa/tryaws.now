import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../flags";
import { childId } from "./ids";
import { autoRenewAtPurchase, purchaseSubscription } from "./purchase";

// WPU-Z2 (owner decision of 2026-11-13: auto-renew on at purchase). A purchase opens its subscription with
// auto-renew on only for a family that the customer can switch off in the panel AND whose renewal gives the
// next period of the service: a Linux server today. Every other family is bought with auto-renew off, as
// before WPU-Z2, so nothing is charged that the customer cannot stop and nothing is charged for a renewal
// that does not happen. No database here: runPurchase passes this input to createSubscription as it is. The
// stored row is read by the database tests purchase.test.ts (a Linux server: on), domain-purchase.test.ts
// and dns-zone-order.test.ts (off).

const ORDER = "0190aaaa-0000-7000-8000-0000000000a1";
const RESOURCE = childId(ORDER, "resource");
const NOW = new Date("2026-11-13T06:00:00.000Z");
const SNAPSHOT = { v: 1, currency: "BDT", totalMinor: "74295" };
const DAY_MS = 86_400_000;

describe("autoRenewAtPurchase (WPU-Z2)", () => {
  it("is on for a Linux server, whose Billing tab has the switch that turns it off", () => {
    expect(autoRenewAtPurchase("linux_instance")).toBe(true);
  });

  it("is off for a domain: a renewal would take the money, but nothing renews the name at the registry (spec 17, open item 79)", () => {
    expect(autoRenewAtPurchase("domain")).toBe(false);
  });

  it("is off for every family the customer cannot switch off in the panel", () => {
    for (const family of [
      "windows_instance",
      "disk",
      "database",
      "bucket",
      "load_balancer",
      "container_service",
      "cdn",
      "dns_zone",
      "static_ip",
      "backup",
    ]) {
      expect(autoRenewAtPurchase(family), family).toBe(false);
    }
  });

  it("is off for a family it does not know (R16)", () => {
    expect(autoRenewAtPurchase("something_new")).toBe(false);
    expect(autoRenewAtPurchase("")).toBe(false);
    expect(autoRenewAtPurchase("LINUX_INSTANCE")).toBe(false);
  });

  it("is on for exactly one of the twelve product families", () => {
    expect(FEATURE_FLAGS.filter((family) => autoRenewAtPurchase(family))).toEqual([
      "linux_instance",
    ]);
  });
});

describe("purchaseSubscription (WPU-Z2)", () => {
  it("covers the twelve product families", () => {
    expect(FEATURE_FLAGS).toHaveLength(12);
  });

  it.each(FEATURE_FLAGS.map((family) => [family]))(
    "%s: the term of the family from the purchase, auto-renew on only for a Linux server",
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
        autoRenew: family === "linux_instance",
      });
    },
  );
});
