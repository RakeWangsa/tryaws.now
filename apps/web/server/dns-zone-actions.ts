import { parseDnsZoneConfig } from "@tc/core";
import { z } from "zod";
import { destroyFamilyCore } from "./family-actions.ts";
import type { FamilyActionDeps, FamilyResult, FamilySpec } from "./family-actions.ts";
import { formObject, formText } from "./form-schema.ts";
import { publicErrorOf } from "./order-actions.ts";
import type { DraftActionResult, OrderActionDeps } from "./order-actions.ts";

// The cores of the Server Actions of the DNS zone screens (/dns, WPU-G6): `createOrderDraft` (review) and
// `destroyDnsZone`. R9 order in each: authenticate, authorize (the flag and the ownership of the zone),
// validate, rate limit, execute, audit. Every action is a draft or an operation row (R1: nothing here
// calls AWS). The zone name is the only customer text that goes on, and only after the rule of
// packages/core/dns accepted it (R11); what leaves a core is a fixed public key (U6).

export const DNS_ZONE_SPEC: FamilySpec = {
  family: "dns_zone",
  idField: "zoneId",
  prefix: "dns",
  // A hosted zone has no snapshot: its records stay in resources.config (R13, spec 11).
  withFinalSnapshot: false,
  nameKey: "zoneName",
};

// The shape of the form (R9: zod). The rule of a zone name is in packages/core/dns, one source.
const form = formObject({
  zoneName: formText.pipe(z.string().max(253)),
  declaredControl: formText.pipe(z.string().max(8).optional()),
});

/**
 * /dns: the zone name and the declaration that the customer controls it become the config of a zone
 * order. The family is an argument of the code, never a form field. The declaration is the checkbox: its
 * value is the word "on", nothing else counts.
 */
export async function createDnsZoneDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const shaped = form.safeParse(raw);
  if (!shaped.success)
    return { ok: false, error: "validation", fields: { zoneName: "invalid_name" } };
  const parsed = parseDnsZoneConfig({
    zoneName: shaped.data.zoneName,
    declaredControl: shaped.data.declaredControl === "on",
  });
  if (!parsed.ok) {
    return { ok: false, error: "validation", ...(parsed.fields ? { fields: parsed.fields } : {}) };
  }

  if (deps.orders === null) return { ok: false, error: "unavailable" };
  let allowed: boolean;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!allowed) return { ok: false, error: "rate_limited" };

  const result = await deps.orders.createOrderDraft(session, {
    family: "dns_zone",
    config: { zoneName: parsed.value.zoneName, declaredControl: true },
  });
  if (!result.ok) {
    return {
      ok: false,
      error: publicErrorOf(result.error),
      // A held name is a conflict; the customer is told the name is taken, nothing else.
      ...(result.error === "validation" && result.fields ? { fields: result.fields } : {}),
      ...(result.error === "conflict" ? { fields: { zoneName: "taken" } } : {}),
    };
  }
  return { ok: true, token: result.value.token };
}

/**
 * `destroyDnsZone` (U10, R13; enters the approval queue until 2026-12-01). No final snapshot: the
 * records stay in the configuration of the resource, and the zone is removed from Route 53 by the
 * destroy operation after approval.
 */
export const destroyDnsZoneCore = (deps: FamilyActionDeps, raw: unknown): Promise<FamilyResult> =>
  destroyFamilyCore(deps, DNS_ZONE_SPEC, raw);
