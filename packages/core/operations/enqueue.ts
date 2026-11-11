import { insertOperation, type OperationInput, type Tx } from "@tc/db";
import type { Clock } from "../types";

// F: the row only (queued, or needs_approval when R13 asks for it). The caller sends the queue
// message after the commit with sendAfterCommit(queue, firstMessage(operationId, resourceId)).
export function makeEnqueueOperation(
  clock: Clock,
): (tx: Tx, input: OperationInput) => Promise<{ operationId: string }> {
  return async (tx, input) => {
    const { operationId } = await insertOperation(tx, input, clock.now());
    return { operationId };
  };
}

// The function of F with exactly its two parameters. It takes no customer id, so it checks no
// owner: it is for system code. A Server Action of apps/ may not import it (lint rule); customer
// requests use customerRepos(...).operations.request.
export const enqueueOperation: (tx: Tx, input: OperationInput) => Promise<{ operationId: string }> =
  makeEnqueueOperation({ now: () => new Date() });
