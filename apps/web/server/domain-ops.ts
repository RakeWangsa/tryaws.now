import {
  checkSecondConfirmation,
  normalizeDomainName,
  parseNameServers,
  splitNameServers,
} from "@tc/core";
import { z } from "zod";
import { DOMAIN_WRITE_LIMIT } from "./domain-actions.ts";
import type { DomainActionDeps, DomainError, DomainRepos } from "./domain-actions.ts";
import { formObject, formText } from "./form-schema.ts";

// WPU-B2: the cores of the two domain actions that go to Route 53 Domains: "send the verification e-mail
// again" and "change the name servers". R1: the web tier calls no AWS client. Each core validates, then
// writes ONE operation row (kinds `resend_verification` and `set_name_servers`, both customer-requestable)
// that the provisioner runs in the tc-dns account; the domain adapter validates the payload again.
// R9 order: authenticate, authorize (the flag, the ownership, the state of the domain), validate, rate
// limit, execute, audit. R7: the key is the request id of the page (plus a digest of the servers). The
// renewal (`renew_domain`) is NOT a customer action: it costs money and is enqueued by the lifecycle only
// (JOURNEY, Needs decision). What leaves a core is a fixed public key (U6); a typed server name is never
// echoed (R14).

export type DomainOpsResult =
  | { ok: true; done: "verificationSent" | "nameServersRequested" }
  | { ok: false; error: DomainError | "not_allowed" | "busy"; fields?: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IN_FLIGHT = ["queued", "running", "waiting", "needs_approval"];
// The row says what the domain is; only a registered one (or one that waits for the e-mail check) has a
// registry record to talk to. Expired, failed, pending and review rows are refused (R16).
const REGISTERED = ["registered", "awaiting_verification"];

class Refusal extends Error {
  constructor(
    readonly error: Extract<DomainOpsResult, { ok: false }>["error"],
    readonly fields?: Record<string, string>,
  ) {
    super(error);
  }
}

const fail = (
  error: Extract<DomainOpsResult, { ok: false }>["error"],
  fields?: Record<string, string>,
): DomainOpsResult => ({ ok: false, error, ...(fields ? { fields } : {}) });

/** FNV-1a, 32 bit, for the idempotency key. Not a security function. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const resendForm = formObject({
  name: formText.pipe(z.string().max(253)),
  requestId: formText.pipe(z.string().regex(UUID)),
});

const nameServersForm = formObject({
  name: formText.pipe(z.string().max(253)),
  requestId: formText.pipe(z.string().regex(UUID)),
  nameServers: formText.pipe(z.string().max(2000)),
  confirmName: formText,
});

/** Shape only: the owned row is looked up by the exact name, and the TLD is what follows the label. */
function shapeOfName(raw: string) {
  const typed = raw.toLowerCase();
  return normalizeDomainName(typed, [typed.slice(typed.indexOf(".") + 1)]);
}

/** The authorization half, inside the store: flag, ownership, family, state. Returns the resource id. */
async function authorize(repos: DomainRepos, name: string): Promise<string> {
  if (!(await repos.domainOn())) throw new Refusal("flag_off");
  // Another customer's domain and a missing one are the same answer (R8).
  const row = await repos.domains.getByName(name);
  if (row === null) throw new Refusal("not_found");
  const resource = await repos.resources.get(row.resourceId);
  if (resource === null || resource.family !== "domain") throw new Refusal("not_found");
  if (resource.state !== "active" || !REGISTERED.includes(row.status)) {
    throw new Refusal("not_allowed");
  }
  return row.resourceId;
}

function refusalOf(written: { error: string }): Refusal {
  return new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
}

export async function resendVerificationCore(
  deps: DomainActionDeps,
  raw: unknown,
): Promise<DomainOpsResult> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");
  const parsed = resendForm.safeParse(raw);
  const input = parsed.success ? parsed.data : { name: "", requestId: "" };
  const name = shapeOfName(input.name);
  const bad: Record<string, string> = {};
  if (!name.ok) bad["name"] = "invalid";
  if (!UUID.test(input.requestId)) bad["requestId"] = "invalid";
  if (!name.ok || Object.keys(bad).length > 0) return fail("validation", bad);

  try {
    return await deps.store(session.customerId, async (repos) => {
      const resourceId = await authorize(repos, name.value.name);
      const decision = await repos.rateLimits.consume(DOMAIN_WRITE_LIMIT, deps.now());
      if (!decision.allowed) return fail("rate_limited");
      const written = await repos.operations.request({
        resourceId,
        kind: "resend_verification",
        idempotencyKey: `domain.resend:${input.requestId}`,
        payload: {},
      });
      if (!written.ok) throw refusalOf(written);
      const audited = await repos.audit.record({
        action: "domain.resend_verification",
        targetType: "resource",
        targetId: resourceId,
      });
      // The audit entry is part of the action: without it everything rolls back (R9, R16).
      if (!audited.ok) throw new Error("domain-ops: the audit entry was refused");
      return { ok: true, done: "verificationSent" } satisfies DomainOpsResult;
    });
  } catch (error) {
    return error instanceof Refusal ? fail(error.error, error.fields) : fail("unavailable");
  }
}

export async function setNameServersCore(
  deps: DomainActionDeps,
  raw: unknown,
): Promise<DomainOpsResult> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");
  const parsed = nameServersForm.safeParse(raw);
  const input = parsed.success
    ? parsed.data
    : { name: "", requestId: "", nameServers: "", confirmName: undefined };
  const name = shapeOfName(input.name);
  const bad: Record<string, string> = {};
  if (!name.ok) bad["name"] = "invalid";
  if (!UUID.test(input.requestId)) bad["requestId"] = "invalid";
  const servers = parseNameServers(splitNameServers(input.nameServers));
  if (!servers.ok) bad["nameServers"] = "invalid";
  // The second confirmation repeats the exact name: the servers decide who answers for the domain.
  if (name.ok && !checkSecondConfirmation(name.value.name, input.confirmName).ok) {
    bad["confirmName"] = "mismatch";
  }
  if (!name.ok || !servers.ok || Object.keys(bad).length > 0) return fail("validation", bad);

  try {
    return await deps.store(session.customerId, async (repos) => {
      const resourceId = await authorize(repos, name.value.name);
      const decision = await repos.rateLimits.consume(DOMAIN_WRITE_LIMIT, deps.now());
      if (!decision.allowed) return fail("rate_limited");
      // One change at a time: two changes would each wait for the registry to answer the other.
      const before = await repos.operations.listForResource(resourceId);
      if (before.some((o) => o.kind === "set_name_servers" && IN_FLIGHT.includes(o.state))) {
        throw new Refusal("busy");
      }
      const written = await repos.operations.request({
        resourceId,
        kind: "set_name_servers",
        idempotencyKey: `domain.nameservers:${input.requestId}:${digest(servers.value.join(","))}`,
        payload: { nameServers: servers.value },
      });
      if (!written.ok) throw refusalOf(written);
      const audited = await repos.audit.record({
        action: "domain.set_name_servers",
        targetType: "resource",
        targetId: resourceId,
      });
      if (!audited.ok) throw new Error("domain-ops: the audit entry was refused");
      return { ok: true, done: "nameServersRequested" } satisfies DomainOpsResult;
    });
  } catch (error) {
    return error instanceof Refusal ? fail(error.error, error.fields) : fail("unavailable");
  }
}
