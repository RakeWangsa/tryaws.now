import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../flags";
import { childId } from "./ids";
import { autoRenewAtPurchase, purchaseSubscription } from "./purchase";

// WPU-Z2, widened by WPU-Z14 (owner decision of 2026-11-13: auto-renew on at purchase). A purchase opens its
// subscription with auto-renew on for every family that the customer can switch off in the panel AND whose
// renewal gives the next period of the service: since WPU-Z14 every family with a subscription of its own but a disk
// (each detail page has the switch; a domain's renewal renews the name at the registry since WPU-Z13). A
// static IP and a backup are parts of a server with no subscription or switch of their own: off. A disk is
// off (WPU-Z14 review ruling): its switch can become unreachable. No database
// here: runPurchase passes this input to createSubscription as it is. The stored row is read by the database
// tests purchase.test.ts, domain-purchase.test.ts and dns-zone-order.test.ts (all on).

const ORDER = "0190aaaa-0000-7000-8000-0000000000a1";
const RESOURCE = childId(ORDER, "resource");
const NOW = new Date("2026-11-13T06:00:00.000Z");
const SNAPSHOT = { v: 1, currency: "BDT", totalMinor: "74295" };
const DAY_MS = 86_400_000;

const SWITCHED = [
  "linux_instance",
  "windows_instance",
  "database",
  "bucket",
  "load_balancer",
  "container_service",
  "cdn",
  "dns_zone",
  "domain",
] as const;

describe("autoRenewAtPurchase (WPU-Z2, WPU-Z14)", () => {
  it("is on for every family whose detail page has the switch that turns it off", () => {
    for (const family of SWITCHED) expect(autoRenewAtPurchase(family), family).toBe(true);
  });

  it("is on for a domain: since WPU-Z13 a renewal charge renews the name at the registry", () => {
    expect(autoRenewAtPurchase("domain")).toBe(true);
  });

  it("is off for a static IP and a backup: parts of a server with no subscription or switch of their own", () => {
    expect(autoRenewAtPurchase("static_ip")).toBe(false);
    expect(autoRenewAtPurchase("backup")).toBe(false);
  });

  it("is off for a disk: its switch can become unreachable (its server destroyed), so it is never on by itself", () => {
    expect(autoRenewAtPurchase("disk")).toBe(false);
    expect(
      purchaseSubscription({
        orderId: ORDER,
        resourceId: RESOURCE,
        family: "disk",
        priceSnapshot: SNAPSHOT,
        now: NOW,
      }).autoRenew,
    ).toBe(false);
  });

  it("is off for a family it does not know (R16)", () => {
    expect(autoRenewAtPurchase("something_new")).toBe(false);
    expect(autoRenewAtPurchase("")).toBe(false);
    expect(autoRenewAtPurchase("LINUX_INSTANCE")).toBe(false);
  });

  it("is on for exactly nine of the twelve product families", () => {
    expect(FEATURE_FLAGS.filter((family) => autoRenewAtPurchase(family))).toEqual(
      FEATURE_FLAGS.filter((family) => (SWITCHED as readonly string[]).includes(family)),
    );
    expect(FEATURE_FLAGS.filter((family) => autoRenewAtPurchase(family))).toHaveLength(9);
  });
});

describe("purchaseSubscription (WPU-Z2)", () => {
  it("covers the twelve product families", () => {
    expect(FEATURE_FLAGS).toHaveLength(12);
  });

  it.each(FEATURE_FLAGS.map((family) => [family]))(
    "%s: the term of the family from the purchase, auto-renew on for every family with a switch",
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
        autoRenew: (SWITCHED as readonly string[]).includes(family),
      });
    },
  );
});
