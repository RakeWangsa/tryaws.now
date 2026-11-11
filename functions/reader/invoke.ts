import type { MetricRange } from "@tc/aws";
import type { ReadCaller } from "@tc/db";
import type { Reader, ReaderResult } from "./handler";

// The direct invocation of the web and admin tiers: `{ action, resourceId, caller, range? }`. The
// event is input (R9): the action and the shapes are checked here, and the caller is rebuilt with the
// two known keys only, so that nothing else the event holds reaches the reader. Whether the caller
// owns the resource is the reader's own check, not this file's.
export type ReaderEvent =
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

export function createInvoke(reader: Reader): (event: unknown) => Promise<ReaderOutput> {
  return async (event) => {
    if (typeof event !== "object" || event === null) return refused("validation");
    const e = event as Record<string, unknown>;
    const action = e["action"];
    const resourceId = e["resourceId"];
    if (action !== "describe" && action !== "metrics") return refused("validation");
    if (typeof resourceId !== "string") return refused("validation");
    const caller = rebuildCaller(e["caller"]);
    if (caller === null) return refused("unauthenticated");
    if (action === "describe") return reader.describe(resourceId, caller);
    const range = e["range"];
    if (typeof range !== "string") return refused("validation");
    return reader.metrics(resourceId, caller, range as MetricRange);
  };
}
