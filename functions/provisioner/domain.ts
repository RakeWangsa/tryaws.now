import {
  AwsError,
  createDomainAdapter,
  type DomainsPort,
  type ProductAdapter,
  type Route53Port,
} from "@tc/aws";
import { domainNameHolder, hostedZoneHeldByOther, withTx } from "@tc/db";

// WP7-T4: the production dependencies of the domain adapter. The two Route 53 clients and the KMS
// unseal are NOT built yet (`@aws-sdk/client-route-53-domains` is not a dependency and needs a recorded
// reason; JOURNEY "Needs decision"): until they are, every port refuses with a fixed local error, a
// create fails closed and its order is reversed. The domain flag is off in production (R12), so no
// order reaches this. The two database reads are real: they decide who holds a name and a zone.
export interface DomainPorts {
  readonly domains: () => DomainsPort;
  readonly route53: () => Route53Port;
  readonly unsealContact: (sealed: Uint8Array) => Promise<unknown>;
}

function notConfigured(): never {
  throw new AwsError({ code: "internal", retryable: false, reason: "not_configured" });
}

const UNCONFIGURED: DomainPorts = {
  domains: notConfigured,
  route53: notConfigured,
  unsealContact: async () => notConfigured(),
};

export function domainAdapter(ports: DomainPorts = UNCONFIGURED): ProductAdapter<unknown> {
  return createDomainAdapter({
    ...ports,
    // The earliest live order for the name wins; a failed create gives the name back.
    holdsName: async (name, resourceId) =>
      (await withTx((tx) => domainNameHolder(tx, name))) === resourceId,
    zoneHeldByOther: (hostedZoneId, resourceId) =>
      withTx((tx) => hostedZoneHeldByOther(tx, hostedZoneId, resourceId)),
  }) as ProductAdapter<unknown>;
}
