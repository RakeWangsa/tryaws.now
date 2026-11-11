const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID in any case. The database returns lower case; callers normalise with toLowerCase. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
