import { NamingError, type NamingField } from "./errors";

export const AWS_NAME_TYPES = [
  "instance",
  "staticip",
  "keypair",
  "snapshot",
  "disk",
  "database",
  "lb",
  "lbcert",
  "bucket",
  "container",
  "cdn",
  "cert",
] as const;

export type AwsNameType = (typeof AWS_NAME_TYPES)[number];

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Refuses anything but a lowercase UUID. Nothing is normalised. Not part of the public API of @tc/core. */
export function assertLowercaseUuid(field: NamingField, value: unknown): asserts value is string {
  if (typeof value !== "string" || !LOWERCASE_UUID.test(value)) throw new NamingError(field);
}

/** `tc-<type>-<the last 16 hex digits of the UUID>`. The only source of an AWS resource name (R11). */
export function awsResourceName(type: AwsNameType, id: string): string {
  if (!(AWS_NAME_TYPES as readonly string[]).includes(type)) throw new NamingError("type");
  assertLowercaseUuid("id", id);
  return `tc-${type}-${id.replaceAll("-", "").slice(16)}`;
}
