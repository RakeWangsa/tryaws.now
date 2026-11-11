// Reads of values that come back from the database. pg returns int8 and numeric as text, so money
// is read with BigInt and never with Number (R4). Every function throws TypeError for a value of
// another kind: a row that does not look as expected stops the action (R16).

const INTEGER_TEXT = /^-?[0-9]{1,40}$/;
const COUNT_TEXT = /^[0-9]{1,15}$/;

export function toMinor(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && INTEGER_TEXT.test(value)) return BigInt(value);
  throw new TypeError("ledger: not an integer amount");
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  throw new TypeError("ledger: not a text value");
}

export function asNullableText(value: unknown): string | null {
  return value === null ? null : asText(value);
}

// For counts and versions, never for money.
export function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && COUNT_TEXT.test(value)) return Number(value);
  throw new TypeError("ledger: not a count");
}
