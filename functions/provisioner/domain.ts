import {
  AwsError,
  createContactUnseal,
  createDomainAdapter,
  createKmsClient,
  createRoute53DomainsPort,
  isKmsKeyArn,
  createRoute53Port,
  recheckRenewal,
  type AwsAccess,
  type DomainsPort,
  type KmsDecryptSender,
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
import { dnsAccountFromEnv } from "./dns-zone";
import type { OperationHooks, RenewalRecheckFn } from "./types";

// WP7-T4: the production dependencies of the domain adapter. WPU-X10 wires them (JOURNEY Needs decision 1 and 2 of
// WP7-T4, resolved by WPU-X10): Route 53 Domains and Route 53 of the tc-dns account through STS AssumeRole with the
// ExternalId and the role TcDnsProvisioner (R3; the provisioner's only DNS role, which also holds the reads it
// needs, infra/org/dns-account.yaml), and the KMS unseal of the registrant contact with the domain-contact key of
// the stage (TC_DOMAIN_CONTACT_KEY_ARN). Without a valid environment every port refuses with a fixed local error, a
// create fails closed and its order is reversed, and a renewal (`renew_domain`, WPU-Z13) fails closed and its charge
// is reversed (renewal-hooks.ts). The domain flag is off in production (R12). The two database reads are real: they
// decide who holds a name and a zone.
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

/**
 * WPU-X10: the ports of the Lambda environment. Each is built on use and without a network call (the clients
 * assume the role on their first request); a missing or malformed value refuses that call only (R16). `kms` builds
 * the KMS client of the function's own Region (AWS_REGION); tests pass a fake.
 */
export function domainPortsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  access: AwsAccess<"provisioner">,
  kms: () => KmsDecryptSender = () => createKmsClient(env.AWS_REGION ?? ""),
): DomainPorts {
  const account = () => dnsAccountFromEnv(env) ?? notConfigured();
  let unseal: ((sealed: Uint8Array) => Promise<unknown>) | undefined;
  return {
    domains: () => createRoute53DomainsPort(access.route53Domains(account(), "TcDnsProvisioner")),
    route53: () => createRoute53Port(access.route53(account(), "TcDnsProvisioner")),
    unsealContact: async (sealed) => {
      const keyArn = env.TC_DOMAIN_CONTACT_KEY_ARN;
      // The key is checked before the client is built: a missing key builds no client and makes no call.
      if (!isKmsKeyArn(keyArn)) return notConfigured();
      unseal ??= createContactUnseal(kms(), keyArn);
      return unseal(sealed);
    },
  };
}

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
 * adapter. Without configured ports every call throws the fixed local error, and the confirm operation records
 * `registry_unreachable`: never a refund (R16).
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
