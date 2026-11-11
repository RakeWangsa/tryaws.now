import type { AttentionHook, Clock, RunTx } from "@tc/core";
import type { RunView, Tx } from "@tc/db";

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
