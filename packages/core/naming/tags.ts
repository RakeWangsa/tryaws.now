import { NamingError } from "./errors";
import { assertLowercaseUuid } from "./names";

export const TC_ENVS = ["production", "staging"] as const;
export type TcEnv = (typeof TC_ENVS)[number];

export const TAG_KEYS = {
  env: "tc:env",
  customer: "tc:customer",
  resource: "tc:resource",
  order: "tc:order",
  os: "tc:os",
} as const;

/** The Lightsail tag shape. */
export interface ResourceTag {
  key: string;
  value: string;
}

const OS_VALUES = ["linux", "windows"] as const;

/** Tags of a resource, built from platform ids only (R11). `tc:os` only when `os` is given. */
export function resourceTags(input: {
  env: TcEnv;
  customerId: string;
  resourceId: string;
  orderId: string;
  os?: "linux" | "windows";
}): ResourceTag[] {
  if (!(TC_ENVS as readonly string[]).includes(input.env)) throw new NamingError("env");
  assertLowercaseUuid("customerId", input.customerId);
  assertLowercaseUuid("resourceId", input.resourceId);
  assertLowercaseUuid("orderId", input.orderId);
  if (input.os !== undefined && !(OS_VALUES as readonly string[]).includes(input.os)) {
    throw new NamingError("os");
  }
  const tags: ResourceTag[] = [
    { key: TAG_KEYS.env, value: input.env },
    { key: TAG_KEYS.customer, value: input.customerId },
    { key: TAG_KEYS.resource, value: input.resourceId },
    { key: TAG_KEYS.order, value: input.orderId },
  ];
  if (input.os !== undefined) tags.push({ key: TAG_KEYS.os, value: input.os });
  return tags;
}
