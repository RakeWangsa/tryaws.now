import type { MetricRange } from "@tc/aws";
import type { ReadCaller } from "@tc/db";
import type { Reader, ReaderResult } from "./handler";

// The direct invocation of the web and admin tiers: `{ action, resourceId, caller, range? }`. The
// event is input (R9): the action and the shapes are checked here, and the caller is rebuilt with the
// two known keys only, so that nothing else the event holds reaches the reader. Whether the caller
// owns the resource is the reader's own check, not this file's.
export type ReaderEvent =
  | { readonly action: "targetHealth"; readonly resourceId: string; readonly caller: ReadCaller }
  | {
      readonly action: "databaseMetrics";
      readonly resourceId: string;
      readonly caller: ReadCaller;
      readonly range: MetricRange;
    }
  | { readonly action: "describe"; readonly resourceId: string; readonly caller: ReadCaller }
  | {
      readonly action: "metrics";
      readonly resourceId: string;
      readonly caller: ReadCaller;
      readonly range: MetricRange;
    };

export type ReaderOutput = ReaderResult<unknown>;

const refused = (error: "validation" | "unauthenticated"): ReaderOutput => ({ ok: false, error });

function rebuildCaller(value: unknown): ReadCaller | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as { customerId?: unknown; adminId?: unknown };
  // Both keys are carried when both are present, so the reader refuses the caller that holds both.
  const out: { customerId?: unknown; adminId?: unknown } = {};
  if (c.customerId !== undefined) out.customerId = c.customerId;
  if (c.adminId !== undefined) out.adminId = c.adminId;
  return out as ReadCaller;
}

// WPU-S6. Which tier invoked the function. The reader has one alias per tier ("web" and "admin"); the
// infra grants lambda:InvokeFunction on the alias ARN of the tier to the role of that tier and on
// nothing else, so the alias named in the ARN that Lambda hands to the handler (context.invokedFunctionArn)
// cannot be chosen by the caller of the event. Anything but exactly those two aliases is no tier.
export type ReaderTier = "web" | "admin";

export function readerTierOf(invokedFunctionArn: unknown): ReaderTier | null {
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

// `customerId` is accepted from the web tier only and `adminId` from the admin tier only. A caller of
// the other kind, of both kinds, or an invocation of no known tier is refused the same way (R16).
function callerFitsTier(caller: ReadCaller, tier: unknown): boolean {
  const c = caller as { customerId?: unknown; adminId?: unknown };
  if (tier === "web") return c.customerId !== undefined && c.adminId === undefined;
  if (tier === "admin") return c.adminId !== undefined && c.customerId === undefined;
  return false;
}

export function createInvoke(
  reader: Reader,
): (event: unknown, tier: ReaderTier | null) => Promise<ReaderOutput> {
  return async (event, tier) => {
    if (typeof event !== "object" || event === null) return refused("validation");
    const e = event as Record<string, unknown>;
    const action = e["action"];
    const resourceId = e["resourceId"];
    if (
      action !== "describe" &&
      action !== "metrics" &&
      action !== "targetHealth" &&
      action !== "databaseMetrics"
    ) {
      return refused("validation");
    }
    if (typeof resourceId !== "string") return refused("validation");
    const caller = rebuildCaller(e["caller"]);
    if (caller === null || !callerFitsTier(caller, tier)) return refused("unauthenticated");
    if (action === "describe") return reader.describe(resourceId, caller);
    if (action === "targetHealth") return reader.targetHealth(resourceId, caller);
    const range = e["range"];
    if (typeof range !== "string") return refused("validation");
    if (action === "databaseMetrics") {
      return reader.databaseMetrics(resourceId, caller, range as MetricRange);
    }
    return reader.metrics(resourceId, caller, range as MetricRange);
  };
}
