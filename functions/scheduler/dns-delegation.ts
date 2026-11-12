import { Resolver } from "node:dns/promises";
import {
  delegationRemovalAt,
  firstMessage,
  validateZoneName,
  type DelegationStore,
  type NsLookup,
  type RunTx,
} from "@tc/core";
import {
  listDnsZonesPendingDelegation,
  markDnsZoneDelegated,
  recordDnsZoneNotices,
  retireUndelegatedDnsZone,
} from "@tc/db";
import { notify } from "@tc/notify";

// WPU-D4 (audit C.24): the parts of the delegation job that touch the process: the DNS lookup of the
// customer's domain (node:dns) and the database. The rules and the loop are in packages/core/dns.

/** The job runs in one run out of this many minutes (the scheduler itself runs every minute). */
export const DNS_DELEGATION_EVERY_MINUTES = 10;

export function dnsDelegationDue(now: Date): boolean {
  return now.getUTCMinutes() % DNS_DELEGATION_EVERY_MINUTES === 0;
}

export interface NsResolver {
  resolveNs(host: string): Promise<string[]>;
}

/** A resolver with a short time-out and one try: a lookup must not eat the deadline of the run. */
export function nodeNsResolver(): NsResolver {
  return new Resolver({ timeout: 2000, tries: 1 });
}

// "There is no NS record for this name" is an answer: the domain does not point anywhere yet. Every
// other error (time-out, SERVFAIL, refusal, no network) says nothing about the domain: failed (R16).
const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND"]);

/**
 * The lookup of the NS records of a zone name. The name is checked again and must be a valid zone
 * name; the answer and the errors are reduced to the three kinds of NsLookup, so no resolver text can
 * reach a log (R14).
 */
export function createNsLookup(resolver: NsResolver): (name: string) => Promise<NsLookup> {
  return async (name) => {
    const checked = validateZoneName(name);
    if (!checked.ok || checked.value !== name) return { kind: "failed" };
    try {
      const names = await resolver.resolveNs(name);
      if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
        return { kind: "failed" };
      }
      return names.length === 0 ? { kind: "none" } : { kind: "ns", names };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return typeof code === "string" && NO_RECORDS.has(code)
        ? { kind: "none" }
        : { kind: "failed" };
    }
  };
}

/**
 * The store of the job. Every call is its own transaction (as worker_rw), so one zone that fails does
 * not undo another. The notice and its record are one transaction: a notice is written once (R7).
 */
export function createDelegationStore(runTx: RunTx): DelegationStore {
  return {
    pending: (limit) => runTx((tx) => listDnsZonesPendingDelegation(tx, limit)),
    markDelegated: (zone, now) => runTx((tx) => markDnsZoneDelegated(tx, zone.id, now)),
    recordNotice: (zone, step, now) =>
      runTx(async (tx) => {
        const recorded = await recordDnsZoneNotices(
          tx,
          zone.id,
          zone.noticesSentAt.length,
          step.missed,
          now,
        );
        if (!recorded) return false;
        await notify(tx, {
          customerId: zone.customerId,
          template: "dns_delegation_notice",
          data: {
            domain: zone.name,
            day: step.day,
            removeAt: delegationRemovalAt(zone.createdAt).toISOString(),
          },
          dedupeKey: `dns-delegation:${zone.id}:${step.notice}`,
        });
        return true;
      }),
    retire: async (zone, now) => {
      const retired = await runTx((tx) => retireUndelegatedDnsZone(tx, zone.id, now));
      if (retired === null) return null;
      // Only a destroy that is queued (no admin approval needed) gets its message now; one that waits
      // for an admin is sent when the admin approves it.
      return {
        message:
          retired.created && retired.state === "queued"
            ? firstMessage(retired.operationId, retired.resourceId)
            : null,
      };
    },
  };
}
