import { insertOperation, pollingRepo, type OperationInput } from "@tc/db";
import { dhakaDay } from "../metering/run";
import {
  firstMessage,
  sendAfterCommit,
  type OperationQueue,
  type QueueMessage,
} from "../operations/queue";
import type { Logger, RunTx } from "../operations/types";
import type { Clock } from "../types";

// WPU-B3 (item 21). Two polls of the scheduler, both only operation rows (R1), both idempotent by a key that
// holds the bucket (R7):
//  - read_db_parameters: the parameter list of each active database is read again when the last reading is
//    older than DB_PARAMETERS_STALE_HOURS, so the page shows what Lightsail holds even if nobody opens the
//    editor. One operation for each database and Dhaka day.
//  - refresh_certificate: a load balancer, CDN or container service whose certificate waits (for validation
//    or for the attach) is asked once an hour, so an issued certificate is attached without the customer
//    pressing the button. One operation for each resource and hour.
// A new operation waits for a person only if R13 asks (neither kind is destructive). The operation is not
// sent twice for a replay. The sweeper recovers a lost send (3.4).

export const DB_PARAMETERS_STALE_HOURS = 24;
export const POLL_PAGE = 200;
export const POLL_MAX_PAGES = 5;
const HOUR_MS = 3_600_000;

export interface PollingDeps {
  readonly runTx: RunTx;
  readonly clock: Clock;
  readonly log: Logger;
  readonly queue?: OperationQueue;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface PollingReport {
  /** New read_db_parameters operations. */
  readonly databases: number;
  /** New refresh_certificate operations. */
  readonly certificates: number;
  /** Operations that already existed for the bucket. */
  readonly replayed: number;
  /** Resources whose operation could not be written (logged by id). */
  readonly failed: number;
}

type PollKind = "read_db_parameters" | "refresh_certificate";

function inputFor(kind: PollKind, resourceId: string, now: Date): OperationInput {
  const bucket = kind === "read_db_parameters" ? dhakaDay(now) : now.toISOString().slice(0, 13); // UTC hour
  return {
    resourceId,
    kind,
    payload: { source: "scheduler" },
    idempotencyKey: `poll:${kind.replaceAll("_", "-")}:${resourceId}:${bucket}`,
  };
}

export async function runPolling(deps: PollingDeps): Promise<PollingReport> {
  const now = deps.clock.now();
  if (Number.isNaN(now.getTime())) throw new Error("polling: the clock gave no valid time");
  const pageSize = deps.pageSize ?? POLL_PAGE;
  const maxPages = deps.maxPages ?? POLL_MAX_PAGES;
  const staleBefore = new Date(now.getTime() - DB_PARAMETERS_STALE_HOURS * HOUR_MS);
  const counts = { databases: 0, certificates: 0, replayed: 0, failed: 0 };
  const outbox: QueueMessage[] = [];

  async function poll(
    kind: PollKind,
    list: (afterId: string | null) => Promise<string[]>,
    count: "databases" | "certificates",
  ): Promise<void> {
    let afterId: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      let ids: string[];
      try {
        ids = await list(afterId);
      } catch {
        // A list that cannot be read stops the run (R16): the scheduler rejects and the error metric moves.
        throw new Error("polling: the list could not be read");
      }
      for (const resourceId of ids) {
        try {
          const inserted = await deps.runTx((tx) =>
            insertOperation(tx, inputFor(kind, resourceId, now), now),
          );
          if (!inserted.created) {
            counts.replayed += 1;
            continue;
          }
          counts[count] += 1;
          if (inserted.state === "queued") {
            outbox.push(firstMessage(inserted.operationId, resourceId));
          }
        } catch (error) {
          counts.failed += 1;
          // The kind, the id and the name of the error: never its message (R14).
          deps.log({
            event: "poll_failed",
            kind,
            resourceId,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
      if (ids.length < pageSize) return;
      afterId = ids[ids.length - 1] ?? null;
    }
  }

  await poll(
    "read_db_parameters",
    (afterId) =>
      deps.runTx((tx) => pollingRepo(tx).databasesToRead(staleBefore, afterId, pageSize)),
    "databases",
  );
  await poll(
    "refresh_certificate",
    (afterId) => deps.runTx((tx) => pollingRepo(tx).certificatesToRefresh(afterId, pageSize)),
    "certificates",
  );

  if (deps.queue !== undefined) {
    for (const message of outbox) await sendAfterCommit(deps.queue, message);
  }
  return counts;
}
