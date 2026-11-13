import type { CustomerSession } from "@tc/auth";
import { z } from "zod";
import {
  checkSecondConfirmation,
  normalizeDomainName,
  parseRegistrantContact,
  redactContact,
} from "@tc/core";
import type {
  AuditRepo,
  CustomerLimit,
  DomainsRepo,
  OperationsRepo,
  RateLimitsRepo,
  ResourcesRepo,
  SubscriptionsRepo,
} from "@tc/db";
import { formObject, formText } from "./form-schema.ts";
import { publicErrorOf } from "./order-actions.ts";
import type { DraftActionResult, OrderActionDeps } from "./order-actions.ts";

// The cores of the Server Actions of the domain screens (/domains, 16.10): `createOrderDraft` (review)
// with the second confirmation, and the renewal switch. R9 order in each: authenticate, authorize (the
// flag and the ownership of the domain), validate, rate limit, execute, audit. Every action is a draft or
// a row of the customer's own subscription (R1: nothing here calls AWS). The registrant contact is
// personal data (R14): it is sealed here and only the sealed envelope travels in the signed draft token;
// a log or an error never holds a value of it. What leaves a core is a fixed public key (U6).

export interface DomainDraftDeps extends OrderActionDeps {
  /** The sellable TLD rows (id and name) for the name check. */
  tlds(): Promise<readonly { id: string; tld: string }[]>;
  /**
   * The KMS seal of the contact JSON (KycCrypto-like). null = not configured: the draft is refused
   * (R16). The real adapter is a manual VERIFY (JOURNEY).
   */
  seal: ((plaintext: string) => Promise<Uint8Array>) | null;
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

const CONTACT_FIELDS = [
  "contactType",
  "firstName",
  "lastName",
  "organizationName",
  "email",
  "phoneNumber",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "countryCode",
  "zipCode",
] as const;

/**
 * /domains/new: the name, the contact and the typed confirmation become the config of a registration.
 * The family is an argument of the code, never a form field. A mismatch of the typed name is refused
 * before anything is sealed or counted.
 */
export async function createDomainDraftCore(
  deps: DomainDraftDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = record(raw);
  let tlds: readonly { id: string; tld: string }[];
  try {
    tlds = await deps.tlds();
  } catch {
    return { ok: false, error: "unavailable" };
  }
  const fields: Record<string, string> = {};
  const name = normalizeDomainName(
    input["name"],
    tlds.map((row) => row.tld),
  );
  if (!name.ok) Object.assign(fields, name.fields);
  const contact = parseRegistrantContact(
    Object.fromEntries(CONTACT_FIELDS.map((key) => [key, input[key]])),
  );
  if (!contact.ok) Object.assign(fields, contact.fields);
  // The second confirmation repeats the exact domain name (spec 12): no refunds on registrations.
  if (name.ok) {
    const confirmed = checkSecondConfirmation(name.value.name, input["confirmName"]);
    if (!confirmed.ok) Object.assign(fields, confirmed.fields);
  } else {
    fields["confirmName"] = "mismatch";
  }
  if (!name.ok || !contact.ok || Object.keys(fields).length > 0) {
    return { ok: false, error: "validation", fields };
  }

  if (deps.orders === null || deps.seal === null) return { ok: false, error: "unavailable" };
  const tld = tlds.find((row) => row.tld === name.value.tld);
  if (tld === undefined)
    return { ok: false, error: "validation", fields: { name: "tld_unsupported" } };

  let allowed: boolean;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!allowed) return { ok: false, error: "rate_limited" };

  let sealed: Uint8Array;
  try {
    sealed = await deps.seal(JSON.stringify(contact.value));
  } catch {
    return { ok: false, error: "unavailable" };
  }
  // The log view of the contact: the type, the country and the domain of the e-mail only (R14).
  void redactContact(contact.value);

  const result = await deps.orders.createOrderDraft(session, {
    family: "domain",
    config: {
      productId: tld.id,
      name: name.value.name,
      contactSealed: Buffer.from(sealed).toString("base64"),
    },
  });
  if (!result.ok) {
    return {
      ok: false,
      error: publicErrorOf(result.error, result.data),
      // A held name is a conflict; the customer is told the name is taken, nothing else.
      ...(result.error === "validation" && result.fields ? { fields: result.fields } : {}),
      ...(result.error === "conflict" ? { fields: { name: "taken" } } : {}),
    };
  }
  return { ok: true, token: result.value.token };
}

// ---- the renewal switch ---------------------------------------------------------------------------

export interface DomainRepos {
  domains: DomainsRepo;
  subscriptions: SubscriptionsRepo;
  /** WPU-B2: the resource of the domain (family, state) and the operation rows of the two domain actions. */
  resources: ResourcesRepo;
  operations: OperationsRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
  /** R12, R16: the flag `domain` for the customer's market; false when it cannot be read. */
  domainOn(): Promise<boolean>;
}

export interface DomainActionDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  store<T>(customerId: string, fn: (repos: DomainRepos) => Promise<T>): Promise<T>;
}

export type DomainError =
  "unauthenticated" | "flag_off" | "validation" | "rate_limited" | "not_found" | "unavailable";

export type DomainResult =
  { ok: true; done: string } | { ok: false; error: DomainError; fields?: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// R9 validate: the shape of the renewal switch is a zod schema; only these three fields are read (R11).
// The name is checked in full by normalizeDomainName below, against the TLD that follows its label.
const AutoRenewForm = formObject({
  name: formText.pipe(z.string().max(253)),
  requestId: formText.pipe(z.string().regex(UUID)),
  enabled: formText.pipe(z.enum(["on", "off"])),
});
export const DOMAIN_WRITE_LIMIT: CustomerLimit[] = [
  Object.freeze({ action: "domain.write", limit: 30, windowSeconds: 3600 }),
];

class Refusal extends Error {
  constructor(readonly error: DomainError) {
    super(error);
  }
}

/**
 * The renewal toggle of 16.10. It switches `auto_renew` of the subscription of the customer's own
 * domain; the lifecycle engine charges and extends at the period end (11), so the switch is the whole
 * action. Since WPU-Z14 a domain is bought with auto-renew on (owner decision of 2026-11-13; a renewal
 * renews the name at the registry since WPU-Z13); this switch turns it off.
 */
export async function setDomainAutoRenewCore(
  deps: DomainActionDeps,
  raw: unknown,
): Promise<DomainResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };
  const parsed = AutoRenewForm.safeParse(raw);
  if (!parsed.success) {
    const bad: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string") bad[key] = "invalid";
    }
    return { ok: false, error: "validation", fields: bad };
  }
  const { enabled } = parsed.data;
  // Shape only: the owned row is looked up by the exact name, and the TLD is whatever follows the label.
  const typed = parsed.data.name.toLowerCase();
  const name = normalizeDomainName(typed, [typed.slice(typed.indexOf(".") + 1)]);
  if (!name.ok) return { ok: false, error: "validation", fields: { name: "invalid" } };
  try {
    return await deps.store(session.customerId, async (repos) => {
      if (!(await repos.domainOn())) throw new Refusal("flag_off");
      const decision = await repos.rateLimits.consume(DOMAIN_WRITE_LIMIT, deps.now());
      if (!decision.allowed) return { ok: false, error: "rate_limited" } as DomainResult;
      // Another customer's domain and a missing one are the same answer (R8).
      const row = await repos.domains.getByName(name.value.name);
      if (row === null) throw new Refusal("not_found");
      const written = await repos.subscriptions.setAutoRenew(row.resourceId, enabled === "on");
      if (!written.ok)
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      const audited = await repos.audit.record({
        action: enabled === "on" ? "domain.auto_renew_on" : "domain.auto_renew_off",
        targetType: "resource",
        targetId: row.resourceId,
      });
      // The audit entry is part of the action: without it everything rolls back (R9, R16).
      if (!audited.ok) throw new Error("domains: the audit entry was refused");
      return { ok: true, done: enabled === "on" ? "autoRenewOn" : "autoRenewOff" } as DomainResult;
    });
  } catch (error) {
    return error instanceof Refusal
      ? { ok: false, error: error.error }
      : { ok: false, error: "unavailable" };
  }
}
