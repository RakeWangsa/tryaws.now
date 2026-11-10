import { AwsError } from "./errors";

export const ROLE_NAMES = Object.freeze([
  "TcProvisioner",
  "TcReader",
  "TcAccessDetails",
  "TcDnsProvisioner",
  "TcDnsReader",
  "TcBillingReader",
] as const);
export type RoleName = (typeof ROLE_NAMES)[number];

export const LIGHTSAIL_ROLES = Object.freeze([
  "TcProvisioner",
  "TcReader",
  "TcAccessDetails",
] as const);
export type LightsailRole = (typeof LIGHTSAIL_ROLES)[number];

export const CALLER_ROLES = Object.freeze({
  provisioner: Object.freeze(["TcProvisioner", "TcDnsProvisioner"] as const),
  reader: Object.freeze(["TcReader", "TcDnsReader"] as const),
  "access-details": Object.freeze(["TcAccessDetails"] as const),
  "catalog-sync": Object.freeze(["TcReader", "TcDnsReader"] as const),
  reconciler: Object.freeze(["TcReader", "TcDnsReader", "TcBillingReader"] as const),
} as const satisfies Record<string, readonly RoleName[]>);
export type Caller = keyof typeof CALLER_ROLES;
export type RoleOf<C extends Caller> = (typeof CALLER_ROLES)[C][number];

export const LIGHTSAIL_REGIONS = Object.freeze([
  "ap-southeast-1",
  "ap-south-1",
  "us-east-1",
] as const);
export type LightsailRegion = (typeof LIGHTSAIL_REGIONS)[number];

export interface AccountRef {
  awsAccountId: string;
  externalId: string;
}

// `$` without the `m` flag does not match before a trailing newline.
const ACCOUNT_ID = /^[0-9]{12}$/;
const EXTERNAL_ID = /^[\w+=,.@:/-]{2,1224}$/;

export function assertAccountRef(ref: AccountRef): void {
  const ok =
    typeof ref === "object" &&
    ref !== null &&
    typeof ref.awsAccountId === "string" &&
    typeof ref.externalId === "string" &&
    ACCOUNT_ID.test(ref.awsAccountId) &&
    EXTERNAL_ID.test(ref.externalId);
  if (!ok) {
    throw new AwsError({ code: "internal", retryable: true, reason: "account_ref_invalid" });
  }
}

export function assertRoleAllowed(caller: Caller, role: RoleName): void {
  // Object.hasOwn: a lookup of "__proto__" or "constructor" must not find anything.
  const allowed: readonly string[] | undefined =
    typeof caller === "string" && Object.hasOwn(CALLER_ROLES, caller)
      ? CALLER_ROLES[caller]
      : undefined;
  if (allowed === undefined || typeof role !== "string" || !allowed.includes(role)) {
    throw new AwsError({ code: "forbidden", retryable: true, reason: "role_not_allowed" });
  }
}

export function roleArn(awsAccountId: string, role: RoleName): string {
  return `arn:aws:iam::${awsAccountId}:role/${role}`;
}

export function sessionName(caller: Caller, randomHex16: string): string {
  return `tc-${caller}-${randomHex16}`;
}
