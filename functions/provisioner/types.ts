import type { AwsAccess } from "@tc/aws";
import type {
  AttentionHook,
  RenewalRecheck,
  Clock,
  Logger,
  OperationKind,
  OperationQueue,
  RunTx,
  TcEnv,
} from "@tc/core";
import type { RunView, Tx } from "@tc/db";
import type { AdapterRegistry } from "./adapters";

// The check of R13 that is not about approval: the subscription state allows the action and a final
// snapshot exists where the product supports one. WP5-T4 supplies it; until it does a destructive
// operation is refused. A guard has no effect outside the database and does not catch a database
// error. A guard that throws makes claimStep reject: the transaction rolls back (R16).
export type DestructiveGuard = (tx: Tx, view: RunView) => Promise<boolean>;

export interface ClaimDeps {
  readonly runTx: RunTx;
  readonly clock: Clock;
  readonly hasAdapter: (family: string) => boolean;
  readonly destructiveGuard?: DestructiveGuard;
  readonly onAttention?: AttentionHook;
}

export interface HookEvent {
  readonly operationId: string;
  readonly resourceId: string;
  readonly customerId: string;
  readonly kind: OperationKind;
}

// All hooks run inside the record transaction, so what they write commits or rolls back with the
// state change. They have no effect outside the database and do not catch a database error.
export interface OperationHooks {
  succeeded?(tx: Tx, event: HookEvent): Promise<void>;
  failed?(tx: Tx, event: HookEvent & { readonly code: string }): Promise<void>;
  needsAttention?: AttentionHook;
}

/**
 * WPU-X3 (b): the fresh registry check of a stuck domain renewal (packages/aws recheckRenewal through the domain ports;
 * domain.ts domainRenewalRecheck). Reads only. Throws on any AWS error.
 */
export type RenewalRecheckFn = (input: {
  readonly name: unknown;
  readonly renewOperationId: unknown;
  readonly payload: unknown;
}) => Promise<RenewalRecheck>;

export interface StepDeps extends Omit<ClaimDeps, "hasAdapter"> {
  readonly queue: OperationQueue;
  readonly adapters: AdapterRegistry;
  readonly access: AwsAccess<"provisioner">;
  readonly env: TcEnv;
  readonly hooks?: OperationHooks;
  /** WPU-X3 (b): without it a confirm_unrenewed is refused (renewal_check_missing, R16). */
  readonly renewalRecheck?: RenewalRecheckFn;
  readonly log: Logger;
}

export type RunOutcome =
  | { readonly outcome: "skipped"; readonly reason: "not_found" | "not_runnable" | "blocked" }
  | { readonly outcome: "refused"; readonly code: string }
  | {
      readonly outcome: "advanced";
      readonly to: "queued" | "waiting" | "succeeded" | "failed" | "needs_attention";
      readonly sent: boolean;
    }
  | { readonly outcome: "stale" };
