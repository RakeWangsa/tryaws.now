import type { AccessCode, AccessDetails } from "./handler";

// The direct invocation of the web tier: `{ action, resourceId, caller, requestId? }`. The event is
// input (R9): the action and the shapes are checked here and the caller is rebuilt with its one known
// key, so nothing else the event holds reaches the handler. Only a customer can ask, and only through
// the "web" alias (WPU-N2, the rule of the reader in WPU-S6): the tier is the alias in the invoked ARN
// that Lambda hands to the handler, which the infra lets only the web role invoke. There is no admin
// reveal (R10 would need its own reason and approval): the "admin" alias, an unknown alias, `$LATEST`
// and no alias are all refused for every action (R16).
export type AccessEvent =
  | {
      readonly action: "windows_password" | "database_password" | "bucket_key_list";
      readonly resourceId: string;
      readonly caller: { readonly customerId: string };
    }
  | {
      readonly action: "bucket_key_create";
      readonly resourceId: string;
      readonly requestId: string;
      readonly caller: { readonly customerId: string };
    };

export type AccessTier = "web" | "admin";

export type AccessOutput =
  | Awaited<ReturnType<AccessDetails["windowsPassword"]>>
  | Awaited<ReturnType<AccessDetails["databasePassword"]>>
  | Awaited<ReturnType<AccessDetails["bucketKeyCreate"]>>
  | Awaited<ReturnType<AccessDetails["bucketKeyList"]>>;

const refused = (error: Extract<AccessCode, "validation" | "unauthenticated">): AccessOutput => ({
  ok: false,
  error,
});

// Which alias was invoked: exactly an eight-part Lambda ARN with the alias as its last part.
export function accessTierOf(invokedFunctionArn: unknown): AccessTier | null {
  if (typeof invokedFunctionArn !== "string") return null;
  const parts = invokedFunctionArn.split(":");
  if (
    parts.length !== 8 ||
    parts[0] !== "arn" ||
    parts[2] !== "lambda" ||
    parts[5] !== "function"
  ) {
    return null;
  }
  return parts[7] === "web" || parts[7] === "admin" ? parts[7] : null;
}

const ACTIONS = new Set([
  "windows_password",
  "database_password",
  "bucket_key_create",
  "bucket_key_list",
]);

export function createInvoke(
  access: AccessDetails,
): (event: unknown, tier: AccessTier | null) => Promise<AccessOutput> {
  return async (event, tier) => {
    if (typeof event !== "object" || event === null) return refused("validation");
    const e = event as Record<string, unknown>;
    const action = e["action"];
    if (typeof action !== "string" || !ACTIONS.has(action)) return refused("validation");
    const resourceId = e["resourceId"];
    if (typeof resourceId !== "string") return refused("validation");
    // The customer id is accepted from the web alias only; an admin, no tier or an unknown tier is
    // refused before any lookup.
    if (tier !== "web") return refused("unauthenticated");
    const caller = e["caller"];
    if (typeof caller !== "object" || caller === null) return refused("unauthenticated");
    const c = caller as { customerId?: unknown; adminId?: unknown };
    if (c.adminId !== undefined || typeof c.customerId !== "string") {
      return refused("unauthenticated");
    }
    const who = { customerId: c.customerId };
    switch (action) {
      case "windows_password":
        return access.windowsPassword(resourceId, who);
      case "database_password":
        return access.databasePassword(resourceId, who);
      case "bucket_key_list":
        return access.bucketKeyList(resourceId, who);
      default: {
        const requestId = e["requestId"];
        if (typeof requestId !== "string") return refused("validation");
        return access.bucketKeyCreate(resourceId, requestId, who);
      }
    }
  };
}
