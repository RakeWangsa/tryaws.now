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

const RANDOM_HEX16 = /^[0-9a-f]{16}$/;

function accountRefInvalid(): AwsError {
  return new AwsError({ code: "internal", retryable: true, reason: "account_ref_invalid" });
}

function roleNotAllowed(): AwsError {
  return new AwsError({ code: "forbidden", retryable: true, reason: "role_not_allowed" });
}

function isAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID.test(value);
}

function isRoleName(value: unknown): value is RoleName {
  return typeof value === "string" && (ROLE_NAMES as readonly string[]).includes(value);
}

function isCaller(value: unknown): value is Caller {
  return typeof value === "string" && Object.hasOwn(CALLER_ROLES, value);
}

/**
 * Reads each field once, checks what it read and returns a frozen copy with exactly these two
 * fields. A caller works only with the returned object, never with the one it passed in.
 */
export function checkedAccountRef(ref: AccountRef): AccountRef {
  if (typeof ref !== "object" || ref === null) throw accountRefInvalid();
  const awsAccountId: unknown = ref.awsAccountId;
  const externalId: unknown = ref.externalId;
  if (
    !isAccountId(awsAccountId) ||
    typeof externalId !== "string" ||
    !EXTERNAL_ID.test(externalId)
  ) {
    throw accountRefInvalid();
  }
  return Object.freeze({ awsAccountId, externalId });
}

export function assertAccountRef(ref: AccountRef): void {
  checkedAccountRef(ref);
}

export function assertRoleAllowed(caller: Caller, role: RoleName): void {
  // Object.hasOwn: a lookup of "__proto__" or "constructor" must not find anything.
  const allowed: readonly string[] | undefined = isCaller(caller)
    ? CALLER_ROLES[caller]
    : undefined;
  if (allowed === undefined || typeof role !== "string" || !allowed.includes(role)) {
    throw roleNotAllowed();
  }
}

export function roleArn(awsAccountId: string, role: RoleName): string {
  if (!isAccountId(awsAccountId)) throw accountRefInvalid();
  if (!isRoleName(role)) throw roleNotAllowed();
  return `arn:aws:iam::${awsAccountId}:role/${role}`;
}

export function sessionName(caller: Caller, randomHex16: string): string {
  if (!isCaller(caller)) throw roleNotAllowed();
  if (typeof randomHex16 !== "string" || !RANDOM_HEX16.test(randomHex16)) {
    throw new RangeError("sessionName: the random part must be 16 lower-case hex digits");
  }
  return `tc-${caller}-${randomHex16}`;
}
