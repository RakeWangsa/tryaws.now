import {
  DOMAIN_YEARS,
  normalizeDomainName,
  renewalRecheckVerdict,
  type RenewalRecheck,
  parseNameServers,
  parseRegistrantContact,
  stepDone,
  stepNext,
  stepWait,
  type RegistrantContact,
  type StepResult,
} from "@tc/core";
import type { OperationKind } from "@tc/core";
import { AwsError } from "../errors";
import type { DomainsPort } from "./domains-port";
import type { Route53Port } from "./route53-port";
import type { LiveState, OpCtx, ProductAdapter } from "./types";

// WP7-T4, spec 12: the domain registration in the tc-dns account. Everything goes through the two ports
// (Route 53 Domains and Route 53); the adapter never reaches Lightsail and ignores `ctx.account` (a domain
// has no pool account). A domain is created and renewed, never deleted by us (R13): `destroy` refuses.
//
// Steps of `create` (one per invocation):
//   start  The database must name this resource as the first holder of the name; CheckDomainAvailability;
//          a name that is taken (or premium) fails the create and the money is reversed, it is never
//          adopted. An available name is marked in the resource config (`registrationMarker`).
//   register  Only with the marker. RegisterDomain once; wait. A retry after a lost answer finds the
//          name taken and the domain in this account: with the marker it goes on to `adopt`
//          (RegisterDomain has no token).
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
  /**
   * True when this resource is the earliest live (not failed) holder of the name in the database. The
   * database is the platform's record of who bought a name; a name that AWS lists is not ours because
   * of that.
   */
  readonly holdsName: (name: string, resourceId: string) => Promise<boolean>;
  /** True when another resource already records this hosted zone id. */
  readonly zoneHeldByOther: (hostedZoneId: string, resourceId: string) => Promise<boolean>;
}

export interface DomainAdapterConfig {
  readonly name: string;
  readonly contactSealed: string;
  readonly years: number;
}

const POLL_SECONDS = 60;
// WPU-Z19: the Route 53 FAQ (https://aws.amazon.com/route53/faqs/, read 2026-11-14): "Depending on the TLD you've
// selected, registration can take from a few minutes to several hours." No AWS page gives three days: MAX_WAIT_MS is
// a PLATFORM safety margin, not an AWS limit (owner ruling 2026-11-14: keep 3 days; the order money is held while it
// runs). An operation can also wait for reasons that are not the registry's (GetOperationDetail StatusFlag
// PENDING_CUSTOMER_ACTION, PENDING_SUPPORT_CASE, PENDING_PAYMENT_VERIFICATION). A registration or renewal older than
// this fails closed (a registration's order is reversed; a renewal stops for an admin, WPU-Z13).
const MAX_WAIT_MS = 3 * 24 * 60 * 60 * 1000;
// WPU-Z19: the USD price the order charged, as the decimal text of its price snapshot (R4: never a float here). It is
// Consent.MaxPrice of RegisterDomain and RenewDomain, so AWS refuses instead of charging more than the customer paid.
const USD_TEXT = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,4})?$/;
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

/** The USD price in the operation payload (written by the purchase or the renewal charge); else a refusal (R16). */
function maxPriceOf(payload: unknown): string {
  const value = recordOf(payload)["maxPriceUsd"];
  if (typeof value !== "string" || !USD_TEXT.test(value) || !/[1-9]/.test(value)) {
    throw fail("validation");
  }
  return value;
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

function savedId(config: unknown, key: string): string | null {
  const id = recordOf(config)[key];
  return typeof id === "string" && OPERATION_ID.test(id) ? id : null;
}

/** 2 to 8 distinct host names (the rule of @tc/core, the same one the web action ran). */
function parseServers(raw: unknown): string[] {
  const checked = parseNameServers(raw);
  if (!checked.ok) throw fail("validation");
  return checked.value;
}

function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  const norm = (list: readonly string[]): string =>
    [...new Set(list.map((n) => n.toLowerCase().replace(/\.$/, "")))].sort().join(",");
  return norm(a) === norm(b);
}

export function createDomainAdapter(deps: DomainDeps): ProductAdapter<DomainAdapterConfig> {
  // The marker proves that THIS resource reached the register step: only the start step writes it, and
  // only after the name was available and this resource is the first holder of the name in the database.
  const marked = (ctx: Ctx): boolean =>
    recordOf(ctx.resource.config)["registrationMarker"] === ctx.resource.id;

  async function start(ctx: Ctx): Promise<StepResult> {
    const { name } = ctx.config;
    if (marked(ctx)) return stepNext("register");
    // Another live order for the name, earlier than this one, wins; this one fails and is refunded.
    if (!(await deps.holdsName(name, ctx.resource.id))) throw fail("conflict");
    const availability = await deps.domains().checkAvailability(name);
    if (availability === "unknown") throw fail("upstream_unavailable", true);
    // Taken or premium: a failure, never an adoption. Without the marker nothing here is ours.
    if (availability !== "available") throw fail("conflict");
    return stepNext("register", { configMerge: { registrationMarker: ctx.resource.id } });
  }

  async function register(ctx: Ctx): Promise<StepResult> {
    const port = deps.domains();
    const { name } = ctx.config;
    if (!marked(ctx)) throw fail("conflict");
    if (savedOperationId(ctx.resource.config) !== null) return stepNext("poll");
    if (!(await deps.holdsName(name, ctx.resource.id))) throw fail("conflict");
    const availability = await port.checkAvailability(name);
    if (availability === "unknown") throw fail("upstream_unavailable", true);
    if (availability !== "available") {
      // A retry after a lost answer of RegisterDomain: the name is taken and the marker is ours, so
      // the registration may be ours. `adopt` checks the rest (the zone and its name servers).
      if (availability === "unavailable" && (await port.getDomainDetail(name)) !== null) {
        return stepNext("adopt");
      }
      throw fail("conflict");
    }
    const maxPriceUsd = maxPriceOf(ctx.operation.payload);
    const contact = await contactOf(deps, ctx.config);
    const { operationId } = await port.registerDomain({
      name,
      years: ctx.config.years,
      contact,
      maxPriceUsd,
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
    if (status === "failed" || status === "error") throw fail("conflict");
    if (ctx.clock.now().getTime() - ctx.operation.createdAt.getTime() > MAX_WAIT_MS) {
      throw fail("upstream_unavailable");
    }
    return stepWait("poll", inSeconds(ctx, POLL_SECONDS));
  }

  async function adopt(ctx: Ctx): Promise<StepResult> {
    const { name } = ctx.config;
    // Only a resource that went through `register` adopts anything, and only as the first holder.
    if (!marked(ctx) || !(await deps.holdsName(name, ctx.resource.id))) throw fail("conflict");
    const detail = await deps.domains().getDomainDetail(name);
    if (detail === null) throw fail("upstream_unavailable", true);
    // The zone must be the one of this registration: exactly one zone has the name, its name servers
    // are the ones the domain points to, and no other resource holds it (R16).
    const zones = await deps.route53().findHostedZonesByName(name);
    if (zones.length === 0) throw fail("upstream_unavailable", true);
    const zone = zones.length === 1 ? zones[0] : undefined;
    if (zone === undefined || !HOSTED_ZONE_ID.test(zone.id)) throw fail("conflict");
    const hosts = (list: readonly string[]): string =>
      [...new Set(list.map((n) => n.toLowerCase().replace(/\.$/, "")))].sort().join(",");
    if (zone.nameServers.length === 0 || hosts(zone.nameServers) !== hosts(detail.nameServers)) {
      throw fail("conflict");
    }
    if (await deps.zoneHeldByOther(zone.id, ctx.resource.id)) throw fail("conflict");
    const verified = detail.reachability === "done";
    return stepDone({
      state: "active",
      configMerge: {
        domainStatus: verified ? "registered" : "awaiting_verification",
        reachability: detail.reachability,
        expiresAt: detail.expiresAt === null ? null : detail.expiresAt.toISOString(),
        nameServers: [...detail.nameServers],
        hostedZoneId: zone.id,
      },
    });
  }

  // ---- WPU-B2: the actions of a registered domain --------------------------------------------------

  async function resendAction(ctx: Ctx): Promise<StepResult> {
    const outcome = await resendVerification(deps.domains(), ctx.config.name);
    return stepDone({
      configMerge:
        outcome === "sent"
          ? { verificationEmailResentAt: ctx.clock.now().toISOString() }
          : { reachability: "done", domainStatus: "registered" },
    });
  }

  async function nameServersAction(ctx: Ctx): Promise<StepResult> {
    const port = deps.domains();
    const { name } = ctx.config;
    if (ctx.operation.step === "poll") {
      const operationId = savedId(ctx.resource.config, "nameServerOperationId");
      if (operationId === null) throw fail("internal");
      const { status } = await port.getOperationDetail(operationId);
      if (status === "failed" || status === "error") throw fail("conflict");
      if (status === "in_progress") return waitOrGiveUp(ctx, "poll");
      const detail = await port.getDomainDetail(name);
      if (detail === null) throw fail("upstream_unavailable", true);
      return stepDone({ configMerge: { nameServers: [...detail.nameServers] } });
    }
    const servers = parseServers(recordOf(ctx.operation.payload)["nameServers"]);
    const detail = await port.getDomainDetail(name);
    if (detail === null) throw fail("validation");
    // The registry already has these servers: a repeat of the start is not a second call (R7).
    if (sameHosts(detail.nameServers, servers)) {
      return stepDone({ configMerge: { nameServers: [...detail.nameServers] } });
    }
    const { operationId } = await port.updateNameServers(name, servers);
    return stepWait("poll", inSeconds(ctx, POLL_SECONDS), {
      configMerge: { nameServerOperationId: operationId },
    });
  }

  // The checks before RenewDomain, at step null and again at `submit`: the payload, and the live expiry year. A later
  // live year means that this renewal already went through (a lost answer): done, nothing is renewed twice (R7).
  async function renewalCheck(
    port: DomainsPort,
    ctx: Ctx,
  ): Promise<{ done: StepResult } | { year: number; years: number; maxPriceUsd: string }> {
    const payload = recordOf(ctx.operation.payload);
    const maxPriceUsd = maxPriceOf(payload);
    const year = payload["currentExpiryYear"];
    const years = payload["years"] === undefined ? DOMAIN_YEARS : payload["years"];
    if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2200) {
      throw fail("validation");
    }
    if (typeof years !== "number" || !Number.isInteger(years) || years < 1 || years > 10) {
      throw fail("validation");
    }
    const detail = await port.getDomainDetail(ctx.config.name);
    if (detail === null || detail.expiresAt === null) throw fail("validation");
    const live = detail.expiresAt.getUTCFullYear();
    // The year in the payload is the one the row had when the customer paid.
    if (live > year) {
      return { done: stepDone({ configMerge: { expiresAt: detail.expiresAt.toISOString() } }) };
    }
    // An earlier live year, or a payload that is ahead of AWS, means row and registry disagree (R16).
    if (live !== year) throw fail("validation");
    return { year, years, maxPriceUsd };
  }

  // WPU-Z13: step null only reads, then moves to `submit` in a write of its own (step.ts records it before the next
  // run); RenewDomain is sent only at `submit`. So a failure at step null proves that nothing reached the registry
  // (the charge goes back), and from `submit` on the failure policy of @tc/core (decideFailure,
  // registryHoldsRenewal) takes the renewal as held: at `submit` it gives the charge back only for an error that
  // proves nothing was sent, in the first run there (review round 2: a RenewDomain that timed out after it was sent
  // stays at `submit`); at `poll`, never (WPU-Y2: the registry's failed answer, which a MaxPrice refusal may be, stops
  // in needs_attention for an admin like a give-up or any other error; pinned in test/domain-actions.test.ts).
  async function renewAction(ctx: Ctx): Promise<StepResult> {
    const port = deps.domains();
    const { name } = ctx.config;
    switch (ctx.operation.step) {
      case null: {
        const checked = await renewalCheck(port, ctx);
        return "done" in checked ? checked.done : stepNext("submit");
      }
      case "submit": {
        const checked = await renewalCheck(port, ctx);
        if ("done" in checked) return checked.done;
        const { operationId } = await port.renewDomain({
          name,
          years: checked.years,
          currentExpiryYear: checked.year,
          maxPriceUsd: checked.maxPriceUsd,
        });
        return stepWait("poll", inSeconds(ctx, POLL_SECONDS), {
          configMerge: { renewOperationId: operationId },
        });
      }
      case "poll": {
        const operationId = savedId(ctx.resource.config, "renewOperationId");
        if (operationId === null) throw fail("internal");
        const { status } = await port.getOperationDetail(operationId);
        // WPU-Y2 fix round 1: FAILED for the exact RenewDomain operation id that was saved is the registry's final
        // "not renewed": the failure policy refunds it (registry_failed).
        if (status === "failed") {
          throw new AwsError({ code: "conflict", retryable: false, reason: "registry_failed" });
        }
        if (status === "successful") return renewedExpiry(port, name);
        // WPU-Y2 fix round 2: an operation still SUBMITTED or IN_PROGRESS may still renew (and AWS may still charge):
        // past the give-up it stops in needs_attention with a plain error that never allows a refund.
        if (status === "in_progress") return waitOrGiveUp(ctx, "poll");
        // ERROR, a final answer that is not SUCCESSFUL (not defined by the API reference): a fresh GetDomainDetail.
        return afterRegistryError(port, ctx, name);
      }
      default:
        throw fail("internal");
    }
  }

  function waitOrGiveUp(ctx: Ctx, step: string): StepResult {
    if (ctx.clock.now().getTime() - ctx.operation.createdAt.getTime() > MAX_WAIT_MS) {
      throw fail("upstream_unavailable");
    }
    return stepWait(step, inSeconds(ctx, POLL_SECONDS));
  }

  // WPU-Y2 fix round 2. After an ERROR for the saved RenewDomain operation: a later live expiry year is a renewal that
  // went through (done). `registry_unrenewed`, the one verdict on which an admin may reject the renewal with its
  // refund (functions/provisioner/reject.ts), only when the live expiry is to the millisecond the expiry the row held
  // before the renewal (`currentExpiresAt` of the payload). Anything else (no such instant, a different instant in the
  // same year, an earlier year) is a plain error: needs_attention, never a refund (R16).
  async function afterRegistryError(
    port: DomainsPort,
    ctx: Ctx,
    name: string,
  ): Promise<StepResult> {
    const payload = recordOf(ctx.operation.payload);
    const year = payload["currentExpiryYear"];
    if (typeof year !== "number" || !Number.isInteger(year)) throw fail("validation");
    const before = exactInstant(payload["currentExpiresAt"]);
    const detail = await port.getDomainDetail(name);
    if (detail === null || detail.expiresAt === null) throw fail("upstream_unavailable");
    if (detail.expiresAt.getUTCFullYear() > year) {
      return stepDone({ configMerge: { expiresAt: detail.expiresAt.toISOString() } });
    }
    if (before !== null && detail.expiresAt.getTime() === before.getTime()) {
      throw new AwsError({
        code: "upstream_unavailable",
        retryable: false,
        reason: "registry_unrenewed",
      });
    }
    throw fail("upstream_unavailable");
  }

  function exactInstant(value: unknown): Date | null {
    if (typeof value !== "string") return null;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) || at.toISOString() !== value ? null : at;
  }

  async function renewedExpiry(port: DomainsPort, name: string): Promise<StepResult> {
    const detail = await port.getDomainDetail(name);
    if (detail === null || detail.expiresAt === null) throw fail("upstream_unavailable", true);
    return stepDone({ configMerge: { expiresAt: detail.expiresAt.toISOString() } });
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
          case "register":
            return register(ctx);
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
      // WPU-B2: the three domain actions. Any other kind is refused.
      async action(kind: OperationKind, ctx: Ctx): Promise<StepResult> {
        switch (kind) {
          case "resend_verification":
            return resendAction(ctx);
          case "set_name_servers":
            return nameServersAction(ctx);
          case "renew_domain":
            return renewAction(ctx);
          default:
            throw fail("validation");
        }
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
  input: { readonly name: string; readonly years?: number; readonly maxPriceUsd: string },
): Promise<{ readonly operationId: string }> {
  const maxPriceUsd = maxPriceOf(input);
  const detail = await port.getDomainDetail(input.name);
  if (detail === null || detail.expiresAt === null) throw fail("validation");
  return port.renewDomain({
    name: input.name,
    years: input.years ?? DOMAIN_YEARS,
    currentExpiryYear: detail.expiresAt.getUTCFullYear(),
    maxPriceUsd,
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

// A domain name as the domain adapter stores it (normalizeDomainName: ASCII, lower case, no trailing dot).
const STORED_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * WPU-X3 (b). The fresh registry check of the admin action "registry confirmed not renewed" (operation kind
 * `confirm_unrenewed`, functions/provisioner/confirm-unrenewed.ts). GetOperationDetail of the saved RenewDomain
 * operation first, then GetDomainDetail of the name: a renewal that completes between the two calls shows its later
 * expiry, which is never a refund. The verdict is renewalRecheckVerdict of @tc/core (only FAILED or ERROR with the
 * pre-renewal expiry unchanged to the millisecond is "unrenewed"). A missing operation id or name asks AWS nothing and
 * proves nothing (R16). An AWS error is thrown to the caller; it is never a verdict. Reads only: nothing is changed.
 */
export async function recheckRenewal(
  port: DomainsPort,
  input: { readonly name: unknown; readonly renewOperationId: unknown; readonly payload: unknown },
): Promise<RenewalRecheck> {
  const { name, renewOperationId, payload } = input;
  if (
    typeof name !== "string" ||
    !STORED_NAME.test(name) ||
    typeof renewOperationId !== "string" ||
    !OPERATION_ID.test(renewOperationId)
  ) {
    return { verdict: "kept", reason: "renewal_unreadable" };
  }
  const { status } = await port.getOperationDetail(renewOperationId);
  const detail = await port.getDomainDetail(name);
  return renewalRecheckVerdict({ status, liveExpiresAt: detail?.expiresAt ?? null, payload });
}
