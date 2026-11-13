import {
  AwsError,
  createDomainAdapter,
  recheckRenewal,
  type DomainsPort,
  type ProductAdapter,
  type Route53Port,
} from "@tc/aws";
import { planDomainSync } from "@tc/core";
import {
  applyDomainFacts,
  domainNameHolder,
  hostedZoneHeldByOther,
  readDomainSyncView,
  withTx,
  type Tx,
} from "@tc/db";
import type { OperationHooks, RenewalRecheckFn } from "./types";

// WP7-T4: the production dependencies of the domain adapter. WPU-B2 added the Route 53 Domains client
// (`createRoute53DomainsPort` of @tc/aws), but its credentials (STS AssumeRole into tc-dns, role
// TcDnsProvisioner) and the KMS unseal are NOT wired here yet (JOURNEY "Needs decision"): until they are,
// every port refuses with a fixed local error, a create fails closed and its order is reversed, and a renewal
// (`renew_domain`, WPU-Z13) fails closed and its charge is reversed (renewal-hooks.ts). The domain flag is off in
// production (R12), so no order reaches this. The two database reads are real: they decide who holds a name and a
// zone.
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

/**
 * WPU-X3 (b): the fresh registry check of the admin's "registry confirmed not renewed", on the same ports as the domain
 * adapter. Until the ports are wired (JOURNEY "Needs decision") every call throws the fixed local error, and the
 * confirm operation records `registry_unreachable`: never a refund (R16).
 */
export function domainRenewalRecheck(ports: DomainPorts = UNCONFIGURED): RenewalRecheckFn {
  return (input) => recheckRenewal(ports.domains(), input);
}

/**
 * WPU-B2: keeps `domains.status`, `expires_at`, `hosted_zone_id` and `route53_operation_id` in step with the
 * operations of the domain. The next status comes from the state machine of @tc/core (`planDomainSync`);
 * the write is a compare-and-set on the status that was read, inside the transaction of the state change.
 * A failed create gives the name back (the unique index of migration 0024 ignores a failed row). A resource
 * that is no domain matches no row, so the hook is safe for every family.
 */
export function domainHooks(): OperationHooks {
  async function sync(
    tx: Tx,
    event: { readonly kind: string; readonly resourceId: string },
    outcome: "succeeded" | "failed",
  ): Promise<void> {
    const view = await readDomainSyncView(tx, event.resourceId);
    if (view === null) return;
    const plan = planDomainSync(view.status, event.kind, outcome, view.config);
    if (plan === null) return;
    await applyDomainFacts(tx, event.resourceId, {
      from: view.status,
      to: plan.to,
      ...(plan.expiresAt === undefined ? {} : { expiresAt: plan.expiresAt }),
      ...(plan.hostedZoneId === undefined ? {} : { hostedZoneId: plan.hostedZoneId }),
      ...(plan.route53OperationId === undefined
        ? {}
        : { route53OperationId: plan.route53OperationId }),
    });
  }
  return {
    succeeded: (tx, event) => sync(tx, event, "succeeded"),
    failed: (tx, event) => sync(tx, event, "failed"),
  };
}
