import {
  OPERATION_KIND_INFO,
  isDestructive,
  isOperationKind,
  requiresApproval,
  type OperationState,
} from "./kinds";
import type { LocalFailure } from "./types";

export const BLOCKED_RETRY_SECONDS = 60;

export interface ClaimView {
  readonly state: OperationState;
  readonly kind: string;
  readonly needsApproval: boolean;
  readonly approvedBy: string | null;
  readonly resource: {
    readonly family: string;
    readonly state: string;
    readonly customerId: string;
    readonly poolAccountId: string | null;
    readonly region: string | null;
  } | null;
  readonly pool: { readonly awsAccountId: string; readonly externalId: string } | null;
  // orderCustomerId is orders.customer_id of payload.orderId (read for a create only);
  // keyCustomerId is the customer id inside a "customer:" idempotency key, else null.
  readonly owner: {
    readonly orderCustomerId: string | null;
    readonly keyCustomerId: string | null;
  };
  readonly blockedBy: string | null;
}

export interface ClaimOptions {
  readonly now: Date;
  readonly approvalUntil: Date | null;
  readonly hasAdapter: (family: string) => boolean;
  readonly guardInstalled: boolean;
}

export type ClaimDecision =
  | { readonly action: "run" }
  | { readonly action: "skip" }
  | { readonly action: "block"; readonly until: Date }
  | {
      readonly action: "refuse";
      readonly code: Exclude<LocalFailure, "lease_expired" | "failed_hook_missing">;
    };

const refuse = (code: Extract<ClaimDecision, { action: "refuse" }>["code"]): ClaimDecision => ({
  action: "refuse",
  code,
});

// The first rule that matches wins. Pure: no clock, no database.
export function decideClaim(view: ClaimView, options: ClaimOptions): ClaimDecision {
  if (view.state !== "queued") return { action: "skip" };
  if (!isOperationKind(view.kind)) return refuse("unknown_kind");
  const kind = view.kind;

  if (!view.needsApproval && requiresApproval(kind, options.now, options.approvalUntil)) {
    return refuse("approval_flag_missing");
  }
  if (view.needsApproval && view.approvedBy === null) return refuse("approval_missing");
  if (isDestructive(kind) && !options.guardInstalled) return refuse("destructive_guard_missing");

  const resource = view.resource;
  if (resource === null) return refuse("resource_missing");

  const { keyCustomerId, orderCustomerId } = view.owner;
  if (keyCustomerId !== null && keyCustomerId !== resource.customerId) {
    return refuse("owner_mismatch");
  }
  if (kind === "create" && (orderCustomerId === null || orderCustomerId !== resource.customerId)) {
    return refuse("owner_mismatch");
  }

  // reject_operation (method "engine") works on the database only: no state, placement,
  // adapter or sibling rule applies to it.
  if (OPERATION_KIND_INFO[kind].method === "engine") return { action: "run" };

  if (kind === "create" && resource.state !== "creating") return refuse("resource_state");
  if (resource.state === "destroyed" && kind !== "purge_snapshots") {
    return refuse("resource_state");
  }
  if (resource.poolAccountId === null || resource.region === null || view.pool === null) {
    return refuse("resource_unplaced");
  }
  if (!options.hasAdapter(resource.family)) return refuse("no_adapter");
  if (view.blockedBy !== null) {
    return {
      action: "block",
      until: new Date(options.now.getTime() + BLOCKED_RETRY_SECONDS * 1000),
    };
  }
  return { action: "run" };
}
