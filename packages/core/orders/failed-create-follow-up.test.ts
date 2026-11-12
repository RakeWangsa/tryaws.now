import { describe, expect, it } from "vitest";
import {
  cleanupOperationFor,
  productKeyOfFamily,
  refundNotificationsFor,
} from "./failed-create-follow-up";

const RESOURCE = "0198f0c0-0000-7000-8000-000000000001";
const ORDER = "0198f0c0-0000-7000-8000-000000000002";
const CUSTOMER = "0198f0c0-0000-7000-8000-000000000003";

describe("cleanupOperationFor (10.1: the removal of what the create already made in AWS)", () => {
  it("is one destroy-like operation keyed by the resource, with a payload of fixed words only", () => {
    expect(cleanupOperationFor(RESOURCE)).toEqual({
      resourceId: RESOURCE,
      kind: "cleanup_failed_create",
      payload: { reason: "failed_create" },
      idempotencyKey: `create-cleanup:${RESOURCE}`,
    });
  });
  it("gives the same key for the same resource (R7) and another key for another resource", () => {
    expect(cleanupOperationFor(RESOURCE).idempotencyKey).toBe(
      cleanupOperationFor(RESOURCE).idempotencyKey,
    );
    expect(cleanupOperationFor(ORDER).idempotencyKey).not.toBe(
      cleanupOperationFor(RESOURCE).idempotencyKey,
    );
  });
  it("refuses an id that is not a UUID, with a fixed text", () => {
    expect(() => cleanupOperationFor("x; drop table")).toThrow(
      "orders: the resource id is not a UUID",
    );
  });
});

describe("productKeyOfFamily", () => {
  it("maps the families of resources to the product words of the notifier", () => {
    expect(productKeyOfFamily("linux_instance")).toBe("instance");
    expect(productKeyOfFamily("windows_instance")).toBe("instance");
    expect(productKeyOfFamily("database")).toBe("database");
    expect(productKeyOfFamily("container_service")).toBe("container_service");
    expect(productKeyOfFamily("dns_zone")).toBe("dns_zone");
  });
  it("answers null for a family that has no word (no message is written then)", () => {
    expect(productKeyOfFamily("backup")).toBeNull();
    expect(productKeyOfFamily("")).toBeNull();
    expect(productKeyOfFamily("__proto__")).toBeNull();
  });
});

describe("refundNotificationsFor", () => {
  const input = {
    customerId: CUSTOMER,
    orderId: ORDER,
    family: "linux_instance",
    refundMinor: 74295n,
    balanceMinor: 100000n,
  };
  it("writes one email and one in_app row of order_failed_refunded, with decimal text for the money", () => {
    const rows = refundNotificationsFor(input);
    expect(rows.map((r) => r.channel)).toEqual(["email", "in_app"]);
    for (const row of rows) {
      expect(row.customerId).toBe(CUSTOMER);
      expect(row.template).toBe("order_failed_refunded");
      expect(row.payload).toEqual({
        orderId: ORDER,
        product: "instance",
        failure: "create_failed",
        refundMinor: "74295",
        balanceMinor: "100000",
      });
    }
  });
  it("keys the rows by the order so a replay writes nothing new (R7), in the key space of the notifier", () => {
    expect(refundNotificationsFor(input).map((r) => r.dedupeKey)).toEqual([
      `order_failed_refunded:order-failed:${ORDER}:email`,
      `order_failed_refunded:order-failed:${ORDER}:in_app`,
    ]);
  });
  it("writes nothing for a family without a product word", () => {
    expect(refundNotificationsFor({ ...input, family: "backup" })).toEqual([]);
  });
  it("refuses a negative amount (R16)", () => {
    expect(() => refundNotificationsFor({ ...input, refundMinor: -1n })).toThrow(
      "orders: the refund amount is not valid",
    );
  });
  it("holds no address, no phone and no name in the payload (R14)", () => {
    const text = JSON.stringify(refundNotificationsFor(input));
    expect(text).not.toMatch(/@|\+880|name/i);
  });
});
