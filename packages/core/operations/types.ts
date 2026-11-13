import type { Tx } from "@tc/db";

// Production passes withTx; tests pass (fn) => runTransaction(t.db, fn, { role }).
export type RunTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export type OperationActor = "worker" | "admin";

// A refusal of the engine itself. It always ends in needs_attention, never in failed.
export type LocalFailure =
  | "unknown_kind"
  | "resource_missing"
  | "resource_unplaced"
  | "no_adapter"
  | "invalid_config"
  | "approval_flag_missing"
  | "approval_missing"
  | "destructive_guard_missing"
  | "destructive_guard_refused"
  | "owner_mismatch"
  | "resource_state"
  | "admin_suspended"
  | "failed_hook_missing"
  // WPU-Z13: the rejection of a domain renewal the registry holds is refused (reject.ts); it is not refunded.
  | "renewal_submitted"
  // WPU-Y5 (c): the rejection of a dns_zone create past create_zone is refused: the hosted zone exists (reject.ts).
  | "zone_created"
  // WPU-X3 (b): the outcomes of confirm_unrenewed that leave the renewal and its money as they are
  // (confirm-unrenewed.ts): the target is not a renewal stuck at poll, the registry renewed it or may still, the expiry
  // is not the exact one before, a fact cannot be read, the registry cannot be reached, the target moved during the
  // check, or the provisioner has no registry check installed.
  | "renewal_not_confirmable"
  | "registry_renewed"
  | "renewal_in_progress"
  | "expiry_changed"
  | "renewal_unreadable"
  | "registry_unreachable"
  | "target_changed"
  | "renewal_check_missing"
  | "invalid_step_result"
  | "lease_expired";

export interface AttentionEvent {
  readonly operationId: string;
  readonly resourceId: string;
  readonly kind: string;
  readonly code: string;
}

// Called inside the transaction that moves any operation of any kind to needs_attention or failed.
export type AttentionHook = (tx: Tx, event: AttentionEvent) => Promise<void>;

// A field can only be a primitive, so an error object or a payload cannot be logged by accident (R14).
export type LogEvent = { readonly event: string } & Readonly<
  Record<string, string | number | boolean | null>
>;
export type Logger = (event: LogEvent) => void;
