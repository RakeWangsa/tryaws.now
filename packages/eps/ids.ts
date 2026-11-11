// The merchantTransactionId is made by the server (9.2.1): unguessable, free of customer data,
// at least 10 characters (the table check demands it). A forged return URL cannot name a real payment.
export const MERCHANT_TRANSACTION_ID = /^TCP[0-9a-f]{32}$/;

/** "TCP" + 32 lower-case hex characters from 16 random bytes. The caller passes crypto.randomBytes. */
export function newMerchantTransactionId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.length < 16)
    throw new Error("merchant transaction id: not enough random bytes");
  let hex = "";
  for (let i = 0; i < 16; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return "TCP" + hex;
}

/** The id if the text is exactly an id of ours, else null. */
export function parseMerchantTransactionId(text: unknown): string | null {
  return typeof text === "string" && MERCHANT_TRANSACTION_ID.test(text) ? text : null;
}
