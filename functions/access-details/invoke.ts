import type { AccessDetails, AccessCode } from "./handler";

// The direct invocation of the web tier: `{ action, resourceId, caller }`. The event is input (R9):
// the action and the shapes are checked here and the caller is rebuilt with its one known key, so
// nothing else the event holds reaches the handler. Only a customer can ask; there is no admin
// reveal (R10 would need its own reason and approval).
export type AccessEvent = {
  readonly action: "windows_password";
  readonly resourceId: string;
  readonly caller: { readonly customerId: string };
};

type Output = Awaited<ReturnType<AccessDetails["windowsPassword"]>>;

const refused = (error: Extract<AccessCode, "validation" | "unauthenticated">): Output => ({
  ok: false,
  error,
});

export function createInvoke(access: AccessDetails): (event: unknown) => Promise<Output> {
  return async (event) => {
    if (typeof event !== "object" || event === null) return refused("validation");
    const e = event as Record<string, unknown>;
    if (e["action"] !== "windows_password") return refused("validation");
    const resourceId = e["resourceId"];
    if (typeof resourceId !== "string") return refused("validation");
    const caller = e["caller"];
    if (typeof caller !== "object" || caller === null) return refused("unauthenticated");
    const c = caller as { customerId?: unknown; adminId?: unknown };
    if (c.adminId !== undefined || typeof c.customerId !== "string") {
      return refused("unauthenticated");
    }
    return access.windowsPassword(resourceId, { customerId: c.customerId });
  };
}
