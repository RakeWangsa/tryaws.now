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
