import {
  DOMAIN_YEARS,
  normalizeDomainName,
  parseRegistrantContact,
  stepDone,
  stepNext,
  stepWait,
  type RegistrantContact,
  type StepResult,
} from "@tc/core";
import { AwsError } from "../errors";
import type { DomainsPort } from "./domains-port";
import type { Route53Port } from "./route53-port";
import type { LiveState, OpCtx, ProductAdapter } from "./types";

// WP7-T4, spec 12: the domain registration in the tc-dns account. Everything goes through the two ports
// (Route 53 Domains and Route 53); the adapter never reaches Lightsail and ignores `ctx.account` (a domain
// has no pool account). A domain is created and renewed, never deleted by us (R13): `destroy` refuses.
//
// Steps of `create` (one per invocation):
//   start  CheckDomainAvailability, then RegisterDomain once; wait. A retry after a lost answer finds the
//          name taken and the domain in this account: it goes on to `adopt` (RegisterDomain has no token).
//   poll   GetOperationDetail until it is successful (wait), failed (the create fails, the money is
//          reversed by the hook) or too old.
//   adopt  Read the domain and the hosted zone that RegisterDomain made; never CreateHostedZone (spec 12).

export interface DomainDeps {
  /** The port for Route 53 Domains in tc-dns (us-east-1). Built per call. */
  readonly domains: () => DomainsPort;
  /** The port for Route 53 in tc-dns, to find the zone that the registration made. */
  readonly route53: () => Route53Port;
  /** Opens the sealed contact of the resource (KMS in production). The result is checked again. */
  readonly unsealContact: (sealed: Uint8Array) => Promise<unknown>;
}

export interface DomainAdapterConfig {
  readonly name: string;
  readonly contactSealed: string;
  readonly years: number;
}

const POLL_SECONDS = 60;
const ADOPT_RETRY_SECONDS = 30;
// VERIFY: Route 53 documents that most registrations finish within minutes, some TLDs take up to
// three days. A registration older than this fails closed and the order is reversed.
const MAX_WAIT_MS = 3 * 24 * 60 * 60 * 1000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const OPERATION_ID = /^[A-Za-z0-9-]{1,128}$/;
const HOSTED_ZONE_ID = /^[A-Z0-9]{1,32}$/;

type Ctx = OpCtx<DomainAdapterConfig>;

function fail(
  code: "validation" | "conflict" | "upstream_unavailable" | "internal",
  retryable = false,
): AwsError {
  return new AwsError({ code, retryable });
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function savedOperationId(config: unknown): string | null {
  const id = recordOf(config)["route53OperationId"];
  return typeof id === "string" && OPERATION_ID.test(id) ? id : null;
}

function inSeconds(ctx: Ctx, seconds: number): Date {
  return new Date(ctx.clock.now().getTime() + seconds * 1000);
}

async function contactOf(
  deps: DomainDeps,
  config: DomainAdapterConfig,
): Promise<RegistrantContact> {
  let opened: unknown;
  try {
    opened = await deps.unsealContact(new Uint8Array(Buffer.from(config.contactSealed, "base64")));
  } catch {
    throw fail("internal");
  }
  const parsed = parseRegistrantContact(opened);
  if (!parsed.ok) throw fail("validation");
  return parsed.value;
}

export function createDomainAdapter(deps: DomainDeps): ProductAdapter<DomainAdapterConfig> {
  async function start(ctx: Ctx): Promise<StepResult> {
    const port = deps.domains();
    const { name } = ctx.config;
    if (savedOperationId(ctx.resource.config) !== null) return stepNext("poll");
    const availability = await port.checkAvailability(name);
    if (availability === "unknown") throw fail("upstream_unavailable", true);
    if (availability !== "available") {
      // Taken, or premium (refused, open item). If it is taken because an earlier try of this step
      // registered it in this account, go on; otherwise the create fails and the order is reversed.
      if (availability === "unavailable" && (await port.getDomainDetail(name)) !== null) {
        return stepNext("adopt");
      }
      throw fail("conflict");
    }
    const contact = await contactOf(deps, ctx.config);
    const { operationId } = await port.registerDomain({
      name,
      years: ctx.config.years,
      contact,
    });
    return stepWait("poll", inSeconds(ctx, POLL_SECONDS), {
      configMerge: { route53OperationId: operationId },
    });
  }

  async function poll(ctx: Ctx): Promise<StepResult> {
    const operationId = savedOperationId(ctx.resource.config);
    if (operationId === null) throw fail("internal");
    const { status } = await deps.domains().getOperationDetail(operationId);
    if (status === "successful") return stepNext("adopt");
    if (status === "failed") throw fail("conflict");
    if (ctx.clock.now().getTime() - ctx.operation.createdAt.getTime() > MAX_WAIT_MS) {
      throw fail("upstream_unavailable");
    }
    return stepWait("poll", inSeconds(ctx, POLL_SECONDS));
  }

  async function adopt(ctx: Ctx): Promise<StepResult> {
    const { name } = ctx.config;
    const detail = await deps.domains().getDomainDetail(name);
    if (detail === null) throw fail("upstream_unavailable", true);
    const zone = await deps.route53().findHostedZoneByName(name);
    const verified = detail.reachability === "done";
    return stepDone({
      state: "active",
      configMerge: {
        domainStatus: verified ? "registered" : "awaiting_verification",
        reachability: detail.reachability,
        expiresAt: detail.expiresAt === null ? null : detail.expiresAt.toISOString(),
        nameServers: [...detail.nameServers],
        ...(zone !== null && HOSTED_ZONE_ID.test(zone.id) ? { hostedZoneId: zone.id } : {}),
      },
    });
  }

  return {
    family: "domain",
    parseConfig(input: unknown): DomainAdapterConfig {
      const raw = recordOf(input);
      const tld = raw["tld"];
      const checked = normalizeDomainName(raw["name"], typeof tld === "string" ? [tld] : []);
      const sealed = raw["contactSealed"];
      if (!checked.ok || checked.value.name !== raw["name"]) throw fail("validation");
      if (typeof sealed !== "string" || sealed.length < 8 || !BASE64.test(sealed)) {
        throw fail("validation");
      }
      const years = raw["years"] === undefined ? DOMAIN_YEARS : raw["years"];
      if (typeof years !== "number" || !Number.isInteger(years) || years < 1 || years > 10) {
        throw fail("validation");
      }
      return { name: checked.value.name, contactSealed: sealed, years };
    },
    aws: {
      async create(ctx: Ctx): Promise<StepResult> {
        switch (ctx.operation.step) {
          case null:
          case "start":
            return start(ctx);
          case "poll":
            return poll(ctx);
          case "adopt":
            return adopt(ctx);
          default:
            throw fail("internal");
        }
      },
      // A domain has nothing to suspend or resume: the registry keeps it. The lifecycle marks the state.
      suspend: async () => stepDone(),
      resume: async () => stepDone(),
      finalSnapshot: async () => stepDone(),
      purgeSnapshots: async () => stepDone(),
      // R13: a domain expires; TiCON never deletes it. The destructive guard refuses it first.
      destroy: async () => {
        throw fail("validation");
      },
      async describe(ctx: Ctx): Promise<LiveState> {
        const detail = await deps.domains().getDomainDetail(ctx.config.name);
        return { state: detail === null ? "missing" : "active" };
      },
      // No operation kind of the contract is a domain action yet (JOURNEY: Needs decision).
      action: async () => {
        throw fail("validation");
      },
    },
  };
}

/**
 * RenewDomain for a name this account holds, for the renewal hook that a later task installs (the
 * operation kind `renew_domain` needs a migration; JOURNEY). `CurrentExpiryYear` comes from the live
 * domain, so a repeat after a success is refused by Route 53 instead of renewing twice.
 */
export async function renewDomainOnce(
  port: DomainsPort,
  input: { readonly name: string; readonly years?: number },
): Promise<{ readonly operationId: string }> {
  const detail = await port.getDomainDetail(input.name);
  if (detail === null || detail.expiresAt === null) throw fail("validation");
  return port.renewDomain({
    name: input.name,
    years: input.years ?? DOMAIN_YEARS,
    currentExpiryYear: detail.expiresAt.getUTCFullYear(),
  });
}

/** ResendContactReachabilityEmail; only while the check is still open. */
export async function resendVerification(
  port: DomainsPort,
  name: string,
): Promise<"sent" | "not_needed"> {
  const detail = await port.getDomainDetail(name);
  if (detail === null) throw fail("validation");
  if (detail.reachability === "done") return "not_needed";
  await port.resendContactReachabilityEmail(name);
  return "sent";
}
