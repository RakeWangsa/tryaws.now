import type { OperationUpdate, Tx, UpdateResult } from "@tc/db";
import { updateOperation } from "@tc/db";
import { assertTransition } from "./states";
import type { OperationActor } from "./types";

// The one way the runner and the sweeper change the state of an operation. An illegal pair throws
// before any statement is sent; a legal pair is one UPDATE under the fence of updateOperation.
export async function transitionOperation(
  tx: Tx,
  actor: OperationActor,
  update: OperationUpdate,
): Promise<UpdateResult> {
  assertTransition(actor, update.from, update.to);
  return updateOperation(tx, update);
}
