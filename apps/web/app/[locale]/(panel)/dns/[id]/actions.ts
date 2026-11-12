"use server";

import { dnsActionDeps, guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { changeRecordCore } from "../../../../../server/dns-actions.ts";
import { destroyDnsZoneCore } from "../../../../../server/dns-zone-actions.ts";
import type { FamilyResult } from "../../../../../server/family-actions.ts";
import { familyActionDeps } from "../../../../../server/family-deps.ts";

// The thin Server Actions of the DNS record editor (WPU-G4): the origin check, then the core (R9), and a
// FormState with a fixed key and the field codes of packages/core/dns (U6). No customer id is read from
// the form: the core takes it from the session (R8).

async function run(input: Record<string, string>): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  const result = await changeRecordCore(dnsActionDeps(), input);
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.done };
}

/** Adds a record (mode create) or replaces one (mode upsert). A delete cannot come through here. */
export async function saveRecordAction(_previous: FormState, form: FormData): Promise<FormState> {
  const input = pick(form, ["zoneId", "requestId", "mode", "name", "type", "ttl", "values"]);
  if (input["mode"] !== "create" && input["mode"] !== "upsert") return { error: "validation" };
  return run(input);
}

/** Deletes the record set with this name and type. */
export async function deleteRecordAction(_previous: FormState, form: FormData): Promise<FormState> {
  return run({ ...pick(form, ["zoneId", "requestId", "name", "type"]), mode: "delete" });
}

/**
 * Asks for the zone to be deleted (U10, R13). The core needs a fresh sign-in, the exact name and the
 * flag; the request waits for approval until 2026-12-01 and the answer says so. No customer id is read
 * from the form: the core takes it from the session (R8).
 */
export async function destroyDnsZoneAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  const result: FamilyResult = await destroyDnsZoneCore(
    familyActionDeps("dns_zone"),
    pick(form, ["zoneId", "requestId", "confirmName"]),
  );
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.approval === true ? `${result.done}:approval` : result.done };
}
