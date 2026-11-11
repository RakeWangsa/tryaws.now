import { NamingError } from "./errors";
import { assertLowercaseUuid } from "./names";

export const TC_ENVS = Object.freeze(["production", "staging"] as const);
export type TcEnv = (typeof TC_ENVS)[number];

export const TAG_KEYS = Object.freeze({
  env: "tc:env",
  customer: "tc:customer",
  resource: "tc:resource",
  order: "tc:order",
  os: "tc:os",
} as const);

/** The Lightsail tag shape. */
export interface ResourceTag {
  key: string;
  value: string;
}

const OS_VALUES = Object.freeze(["linux", "windows"] as const);

/** Tags of a resource, built from platform ids only (R11). `tc:os` only when `os` is given. */
export function resourceTags(input: {
  env: TcEnv;
  customerId: string;
  resourceId: string;
  orderId: string;
  os?: "linux" | "windows";
}): ResourceTag[] {
  if (typeof input !== "object" || input === null) throw new NamingError("input");
  // Read every field once: the tags are built from what was checked, not from a second read.
  const { env, customerId, resourceId, orderId, os } = input;
  if (!(TC_ENVS as readonly string[]).includes(env)) throw new NamingError("env");
  assertLowercaseUuid("customerId", customerId);
  assertLowercaseUuid("resourceId", resourceId);
  assertLowercaseUuid("orderId", orderId);
  if (os !== undefined && !(OS_VALUES as readonly string[]).includes(os)) {
    throw new NamingError("os");
  }
  const tags: ResourceTag[] = [
    { key: TAG_KEYS.env, value: env },
    { key: TAG_KEYS.customer, value: customerId },
    { key: TAG_KEYS.resource, value: resourceId },
    { key: TAG_KEYS.order, value: orderId },
  ];
  if (os !== undefined) tags.push({ key: TAG_KEYS.os, value: os });
  return tags;
}
