import { sendAfterCommit, type OperationQueue, type QueueMessage } from "../operations/queue";
import type { Logger } from "../operations/types";
import type { Clock } from "../types";
import { delegationStep, nameServersMatch } from "./delegation";
import { validateZoneName } from "./records";

// WPU-D4 (audit C.24, spec 12): the scheduler job that watches the zones in `pending_delegation`. It
// looks up the NS records of the customer's domain and compares them with the name servers of the zone;
// when they match the zone is delegated. A zone that stays undelegated is told on day 7 and day 12 and
// removed after day 14 (a destroy operation; no wallet effect here, see JOURNEY WPU-D4).
//
// Ports only: the DNS lookup, the store and the queue are injected, so this file has no network and no
// database of its own. Rules:
// - The only host name that is looked up is the stored zone name, after validateZoneName accepted it
//   again. Nothing from a request reaches the lookup (R11).
// - A lookup that failed (timeout, SERVFAIL, no network) is unknown: the zone stays as it is, with no
//   notice and no removal, and the run does not fail (R16). "No NS records" is an answer: not delegated.
// - Each zone is its own transaction in the store; one zone that fails does not stop the others.
// - Logs hold counts only: no domain name, no name server (R14).

export interface DelegationZone {
  readonly id: string;
  readonly resourceId: string;
  readonly customerId: string;
  readonly name: string;
  readonly nameServers: readonly string[];
  readonly createdAt: Date;
  readonly noticesSentAt: readonly Date[];
}

export type NsLookup =
  | { readonly kind: "ns"; readonly names: readonly string[] }
  | { readonly kind: "none" }
  | { readonly kind: "failed" };

export interface DelegationNoticeStep {
  readonly notice: 1 | 2;
  readonly day: 7 | 12;
  readonly missed: number;
}

export interface DelegationStore {
  /** The oldest zones in pending_delegation, at most `limit`. */
  pending(limit: number): Promise<readonly DelegationZone[]>;
  /** pending_delegation -> delegated. False when the zone changed meanwhile or its name is held. */
  markDelegated(zone: DelegationZone, now: Date): Promise<boolean>;
  /** Queues the notice and records it on the row in one transaction. False for a replay. */
  recordNotice(zone: DelegationZone, step: DelegationNoticeStep, now: Date): Promise<boolean>;
  /** Queues the destroy of the zone. Null when nothing was done (a replay or a changed row). */
  retire(
    zone: DelegationZone,
    now: Date,
  ): Promise<{ readonly message: QueueMessage | null } | null>;
}

export interface DnsDelegationDeps {
  readonly store: DelegationStore;
  readonly lookup: (name: string) => Promise<NsLookup>;
  readonly clock: Clock;
  readonly log: Logger;
  readonly queue?: OperationQueue;
  readonly limit?: number;
}

export interface DnsDelegationReport {
  readonly examined: number;
  readonly delegated: number;
  readonly noticed: number;
  readonly removed: number;
  /** The lookup failed: nothing was done for these zones. */
  readonly unchecked: number;
  /** A stored name that is not valid, or a zone that could not be moved. */
  readonly skipped: number;
  readonly failed: number;
}

export const DNS_DELEGATION_LIMIT = 20;
const CONCURRENCY = 5;

type Outcome = "delegated" | "noticed" | "removed" | "unchecked" | "skipped" | "none";

export async function runDnsDelegation(deps: DnsDelegationDeps): Promise<DnsDelegationReport> {
  const now = deps.clock.now();
  const zones = await deps.store.pending(deps.limit ?? DNS_DELEGATION_LIMIT);
  const counts = { delegated: 0, noticed: 0, removed: 0, unchecked: 0, skipped: 0, failed: 0 };
  const outbox: QueueMessage[] = [];

  async function check(zone: DelegationZone): Promise<Outcome> {
    // The stored name is checked again; a name that does not pass is never looked up.
    const checked = validateZoneName(zone.name);
    if (!checked.ok || checked.value !== zone.name) return "skipped";

    let answer: NsLookup;
    try {
      answer = await deps.lookup(zone.name);
    } catch {
      return "unchecked";
    }
    if (answer.kind === "failed") return "unchecked";
    if (answer.kind === "ns" && nameServersMatch(answer.names, zone.nameServers)) {
      return (await deps.store.markDelegated(zone, now)) ? "delegated" : "skipped";
    }

    const step = delegationStep({
      createdAt: zone.createdAt,
      now,
      noticesSentAt: zone.noticesSentAt,
    });
    if (step.kind === "notice") {
      const recorded = await deps.store.recordNotice(
        zone,
        { notice: step.notice, day: step.day, missed: step.missed },
        now,
      );
      return recorded ? "noticed" : "none";
    }
    if (step.kind === "remove") {
      const retired = await deps.store.retire(zone, now);
      if (retired === null) return "none";
      if (retired.message !== null) outbox.push(retired.message);
      return "removed";
    }
    return "none";
  }

  // A few lookups at a time: the run has a Lambda deadline and every lookup has its own time-out.
  for (let i = 0; i < zones.length; i += CONCURRENCY) {
    const batch = zones.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((zone) => check(zone)));
    for (const result of results) {
      if (result.status === "rejected") {
        counts.failed += 1;
      } else if (result.value !== "none") {
        counts[result.value] += 1;
      }
    }
  }

  // After the commits; a lost send is found again by the sweeper (3.4).
  if (deps.queue !== undefined) {
    for (const message of outbox) await sendAfterCommit(deps.queue, message);
  }
  return { examined: zones.length, ...counts };
}
