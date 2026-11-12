import { AwsError, createDnsZoneAdapter, type ProductAdapter, type Route53Port } from "@tc/aws";
import { markDnsZone, recordDnsZoneCreated } from "@tc/db";
import type { OperationHooks } from "./types";

// WPU-G6: the DNS zone family in the provisioner. A hosted zone lives in tc-dns and has no pool account
// (see POOLLESS_FAMILIES of step.ts). The Route 53 client is NOT built yet (`@aws-sdk/client-route-53` is
// not a dependency and needs a recorded reason; JOURNEY "Needs decision"): until it is, the port refuses
// with a fixed local error, a create fails closed and its order is reversed. The dns_zone flag is off in
// production (R12), so no order reaches this. The hooks below are real: they keep the `dns_zones` row in
// step with the operations of the zone.
export interface DnsZonePorts {
  readonly route53: () => Route53Port;
}

function notConfigured(): never {
  throw new AwsError({ code: "internal", retryable: false, reason: "not_configured" });
}

const UNCONFIGURED: DnsZonePorts = { route53: notConfigured };

export function dnsZoneAdapter(ports: DnsZonePorts = UNCONFIGURED): ProductAdapter<unknown> {
  return createDnsZoneAdapter(ports) as ProductAdapter<unknown>;
}

/**
 * After a create succeeds the hosted zone id and the name servers move from the resource config to the
 * row, and the zone waits for delegation; a create that failed (and was reversed) or a destroy that
 * succeeded gives the name back. Other kinds do nothing. The writes run in the transaction of the state
 * change; a resource that is no zone matches no row, so the hook is safe for every family.
 */
export function dnsZoneHooks(): OperationHooks {
  return {
    succeeded: async (tx, event) => {
      if (event.kind === "create") await recordDnsZoneCreated(tx, event.resourceId);
      if (event.kind === "destroy") await markDnsZone(tx, event.resourceId, "removed");
    },
    failed: async (tx, event) => {
      if (event.kind === "create") await markDnsZone(tx, event.resourceId, "failed");
    },
  };
}
