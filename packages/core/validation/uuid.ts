// Final review M3: the one UUID check of the id fields that reach a query (R8, R16: an id that is not a UUID
// is never looked up). The text form, in either case, as PostgreSQL's uuid type accepts it. Pure.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
