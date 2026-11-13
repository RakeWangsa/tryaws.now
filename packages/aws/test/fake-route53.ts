import { AwsError } from "../errors";
import { withinBatchLimits } from "../adapters/route53-limits";
import type { R53Change, R53RecordSet, R53Zone, Route53Port } from "../adapters/route53-port";

const key = (s: { name: string; type: string }): string => `${s.name.toLowerCase()}|${s.type}`;

/** An in-memory Route 53 for tests: zones with apex NS and SOA, batches that are all-or-nothing. */
export function createFakeRoute53() {
  const zones = new Map<string, { zone: R53Zone; ref: string; sets: Map<string, R53RecordSet> }>();
  const calls: { op: string; detail?: unknown }[] = [];
  /** WPU-Z19: the changes of CreateHostedZone and their GetChange status (INSYNC unless a test says PENDING). */
  const changes = new Map<string, "pending" | "insync">();
  let next = 1;

  const find = (id: string) => {
    const z = zones.get(id);
    if (z === undefined) throw new AwsError({ code: "not_found", retryable: false });
    return z;
  };

  const port: Route53Port = {
    async createHostedZone(input) {
      calls.push({ op: "createHostedZone", detail: { callerReference: input.callerReference } });
      for (const z of zones.values()) {
        if (z.ref === input.callerReference)
          return { zone: z.zone, created: false, changeId: null };
      }
      const id = `Z${String(next++).padStart(6, "0")}`;
      const zone: R53Zone = {
        id,
        name: `${input.name}.`,
        nameServers: [1, 2, 3, 4].map((i) => `ns-${i}.fake-dns.example.`),
      };
      const sets = new Map<string, R53RecordSet>();
      const ns: R53RecordSet = {
        name: zone.name,
        type: "NS",
        ttl: 172800,
        values: zone.nameServers,
      };
      const soa: R53RecordSet = {
        name: zone.name,
        type: "SOA",
        ttl: 900,
        values: [`${zone.nameServers[0]} awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400`],
      };
      sets.set(key(ns), ns);
      sets.set(key(soa), soa);
      zones.set(id, { zone, ref: input.callerReference, sets });
      const changeId = `C${id}`;
      changes.set(changeId, "insync");
      return { zone, created: true, changeId };
    },
    async getChangeStatus(changeId) {
      calls.push({ op: "getChangeStatus", detail: changeId });
      const status = changes.get(changeId);
      if (status === undefined) throw new AwsError({ code: "not_found", retryable: false });
      return status;
    },
    async getHostedZone(id) {
      calls.push({ op: "getHostedZone" });
      return zones.get(id)?.zone ?? null;
    },
    async findHostedZonesByName(name) {
      calls.push({ op: "findHostedZonesByName" });
      const wanted = `${name.toLowerCase().replace(/\.$/, "")}.`;
      return [...zones.values()].filter((z) => z.zone.name === wanted).map((z) => z.zone);
    },
    async listRecordSets(id) {
      calls.push({ op: "listRecordSets" });
      return [...find(id).sets.values()];
    },
    async changeRecordSets(id, changes: readonly R53Change[]) {
      calls.push({ op: "changeRecordSets", detail: changes });
      // The limits of the real client (WPU-Z19): a batch over them is refused, never applied in part.
      if (!withinBatchLimits(changes)) {
        throw new AwsError({ code: "validation", retryable: false });
      }
      const z = find(id);
      const draft = new Map(z.sets);
      for (const c of changes) {
        const k = key(c.set);
        if (c.action === "CREATE") {
          if (draft.has(k)) throw new AwsError({ code: "conflict", retryable: false });
          draft.set(k, c.set);
        } else if (c.action === "UPSERT") {
          draft.set(k, c.set);
        } else {
          if (!draft.has(k)) throw new AwsError({ code: "conflict", retryable: false });
          draft.delete(k);
        }
      }
      z.sets = draft;
    },
    async deleteHostedZone(id) {
      calls.push({ op: "deleteHostedZone" });
      const z = find(id);
      const extra = [...z.sets.values()].filter((s) => s.type !== "NS" && s.type !== "SOA");
      if (extra.length > 0) throw new AwsError({ code: "conflict", retryable: false });
      zones.delete(id);
    },
  };
  return {
    port,
    calls,
    zones,
    changes,
    /** Puts a set in a zone without going through the adapter. */
    seed(id: string, set: R53RecordSet) {
      find(id).sets.set(key(set), set);
    },
  };
}
