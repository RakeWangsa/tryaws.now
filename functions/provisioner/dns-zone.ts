import {
  AwsError,
  createDnsZoneAdapter,
  createRoute53Port,
  type AccountRef,
  type AwsAccess,
  type ProductAdapter,
  type Route53Port,
} from "@tc/aws";
import { markDnsZone, recordDnsZoneCreated } from "@tc/db";
import type { OperationHooks } from "./types";

// WPU-G6, WPU-D4: the DNS zone family in the provisioner. A hosted zone lives in tc-dns and has no pool
// account (see POOLLESS_FAMILIES of step.ts). The Route 53 client (`@aws-sdk/client-route-53`, behind
// Route53Port) assumes TcDnsProvisioner in the tc-dns account named by TC_DNS_ACCOUNT_ID and
// TC_DNS_EXTERNAL_ID (plain values, 6.3; infra/stacks/workers.ts). Without a valid environment the port
// refuses with a fixed local error, a create fails closed and its order is reversed (R16). The dns_zone
// flag is off in production (R12). The hooks below keep the `dns_zones` row in step with the operations
// of the zone.
export interface DnsZonePorts {
  readonly route53: () => Route53Port;
}

function notConfigured(): never {
  throw new AwsError({ code: "internal", retryable: false, reason: "not_configured" });
}

const UNCONFIGURED: DnsZonePorts = { route53: notConfigured };

// A trailing newline must not pass, so the checks are anchored and have no `m` flag.
const DNS_ACCOUNT_ID = /^[0-9]{12}$/;
const DNS_EXTERNAL_ID = /^[\w+=,.@:/-]{2,1224}$/;

/**
 * WPU-X10: the tc-dns account of the Lambda environment, or null when a value is missing or malformed (the caller
 * fails closed). Shared by the DNS zone and the domain ports.
 */
export function dnsAccountFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AccountRef | null {
  const awsAccountId = env.TC_DNS_ACCOUNT_ID;
  const externalId = env.TC_DNS_EXTERNAL_ID;
  if (
    awsAccountId === undefined ||
    !DNS_ACCOUNT_ID.test(awsAccountId) ||
    externalId === undefined ||
    !DNS_EXTERNAL_ID.test(externalId)
  ) {
    return null;
  }
  return { awsAccountId, externalId };
}

/**
 * The port of the Lambda environment. Built per call (a failed build keeps nothing) and without a
 * network call: the client connects, and assumes the role, on its first request.
 */
export function dnsZonePortsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  access: AwsAccess<"provisioner">,
): DnsZonePorts {
  return {
    route53: () => {
      const account = dnsAccountFromEnv(env);
      if (account === null) return notConfigured();
      return createRoute53Port(access.route53(account, "TcDnsProvisioner"));
    },
  };
}

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
