import { createHash } from "node:crypto";

/** SHA-256 of the token text, base64url, 43 characters: the ledger key of the purchase is built from it. */
export function draftHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

/** The first 16 bytes of a SHA-256 as a UUID with version nibble 5 and the variant bits (open point 4). */
function uuidFrom(text: string): string {
  const bytes = createHash("sha256").update(text, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The order id, derived so that a replay inserts the same row under the same id. */
export function orderIdFor(customerId: string, tokenHash: string): string {
  return uuidFrom(`order|${customerId}|${tokenHash}`);
}

/** The id of the resource or the subscription of an order. */
export function childId(orderId: string, label: "resource" | "subscription" | "domain"): string {
  return uuidFrom(`${label}|${orderId}`);
}
