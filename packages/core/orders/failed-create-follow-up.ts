import type { NewLifecycleNotification, OperationInput } from "@tc/db";

// WPU-B3 (10.1): what follows the automatic reversal of a failed create besides the money: the
// removal of what the create already made in AWS, and the message to the customer. Pure: the caller
// writes the rows in the transaction of the reversal.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One cleanup for each resource: the unique key makes a repeat a replay (R7). */
export function cleanupOperationFor(resourceId: string): OperationInput {
  if (!UUID.test(resourceId)) throw new TypeError("orders: the resource id is not a UUID");
  return {
    resourceId,
    kind: "cleanup_failed_create",
    // Fixed words only (R11): nothing of the customer's.
    payload: { reason: "failed_create" },
    idempotencyKey: `create-cleanup:${resourceId}`,
  };
}

const PRODUCT_OF_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  linux_instance: "instance",
  windows_instance: "instance",
  database: "database",
  disk: "disk",
  bucket: "bucket",
  load_balancer: "load_balancer",
  container_service: "container_service",
  cdn: "cdn",
  static_ip: "static_ip",
  snapshot: "snapshot",
  dns_zone: "dns_zone",
  domain: "domain",
});

/** The product word of the notifier templates (PRODUCT_KEYS), or null for a family that has none. */
export function productKeyOfFamily(family: string): string | null {
  return Object.hasOwn(PRODUCT_OF_FAMILY, family) ? (PRODUCT_OF_FAMILY[family] as string) : null;
}

/**
 * The `order_failed_refunded` message (email and in_app) in the form of the notifications table. The
 * dedupe key is the key of the notifier (`<template>:<key>:<channel>`), so the row exists once for an
 * order whoever writes it (R7). Money is decimal text (the notifier reads text or bigint, R4). The
 * payload holds ids, a product word, a fixed reason and two amounts: no address, no name (R14).
 */
export function refundNotificationsFor(input: {
  readonly customerId: string;
  readonly orderId: string;
  readonly family: string;
  readonly refundMinor: bigint;
  readonly balanceMinor: bigint;
}): NewLifecycleNotification[] {
  if (input.refundMinor < 0n || input.balanceMinor < 0n) {
    throw new RangeError("orders: the refund amount is not valid");
  }
  const product = productKeyOfFamily(input.family);
  if (product === null) return [];
  const template = "order_failed_refunded";
  return (["email", "in_app"] as const).map((channel) => ({
    customerId: input.customerId,
    channel,
    template,
    payload: {
      orderId: input.orderId,
      product,
      failure: "create_failed",
      refundMinor: input.refundMinor.toString(),
      balanceMinor: input.balanceMinor.toString(),
    },
    dedupeKey: `${template}:order-failed:${input.orderId}:${channel}`,
  }));
}
