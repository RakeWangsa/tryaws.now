import type { CustomerSession } from "@tc/auth";
import { isUuid } from "@tc/core";
import { SUPPORT_MESSAGE_KEY, messageBody } from "@tc/db";
import type { AuditRepo, CustomerLimit, RateLimitsRepo, SupportRepo } from "@tc/db";
import { z } from "zod";
import { formObject } from "./form-schema.ts";

// WPU-Z6: the cores of the thread of a support request in the panel (/support/requests/[id]): the
// customer's reply and "Close request". R9 order in each: authenticate (a signed-in customer; no other role
// exists on this side), validate (zod for the shape, the repository's own rules for the text and the key),
// rate limit, execute through the customer's own repositories, audit. The customer comes from the session
// only (R8): a request of another customer answers like a missing one (not_found). The text of a reply is
// stored as data and never logged or audited (R11, R14). The ports are parameters, so the cores run in a
// test without a database.

export interface SupportThreadRepos {
  support: Pick<SupportRepo, "addMessage" | "close">;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
}

export interface SupportThreadDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: SupportThreadRepos) => Promise<T>): Promise<T>;
}

export type SupportThreadError =
  "unauthenticated" | "validation" | "not_found" | "conflict" | "rate_limited" | "unavailable";
export type SupportThreadResult =
  | { ok: true; id: string; replayed: boolean }
  | { ok: false; error: SupportThreadError; fields?: Record<string, string> };

// The same per-customer limiter family as the request form (support.create, 5 an hour): 10 replies and 30
// closes an hour. A replay counts as a hit too; the limiter counts calls, the repository makes them
// idempotent (R7).
export const SUPPORT_REPLY_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "support.reply", limit: 10, windowSeconds: 3600 }),
]);
export const SUPPORT_CLOSE_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "support.close", limit: 30, windowSeconds: 3600 }),
]);

const requestIdField = z.unknown().refine(isUuid);

// The shape of each form (R9: zod). The text rule (CRLF to LF, trimmed, 1 to 5000 characters, no control
// or direction-override character) and the key rule are the repository's, so there is one source for each.
const replyForm = formObject({
  requestId: requestIdField,
  idempotencyKey: z.unknown().refine((v) => typeof v === "string" && SUPPORT_MESSAGE_KEY.test(v)),
  body: z.unknown().refine((v) => messageBody(v) !== null),
});
const closeForm = formObject({ requestId: requestIdField });

function fieldsOf(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const name = issue.path[0];
    if (typeof name === "string") fields[name] = "invalid";
  }
  return fields;
}

type RepoFailure = "validation" | "conflict" | "not_found" | "forbidden";
const publicError = (error: RepoFailure): SupportThreadError =>
  error === "validation" || error === "conflict" || error === "not_found" ? error : "unavailable";

/** The customer's reply on one of their requests. It opens a closed or answered request again. */
export async function addSupportMessageCore(
  deps: SupportThreadDeps,
  raw: unknown,
): Promise<SupportThreadResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const parsed = replyForm.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "validation", fields: fieldsOf(parsed.error) };
  const requestId = parsed.data.requestId as string;
  const input = {
    requestId,
    idempotencyKey: parsed.data.idempotencyKey as string,
    body: parsed.data.body as string,
  };

  try {
    return await deps.store(session.customerId, async (repos): Promise<SupportThreadResult> => {
      const limit = await repos.rateLimits.consume(SUPPORT_REPLY_LIMITS, deps.now());
      if (!limit.allowed) return { ok: false, error: "rate_limited" };

      const written = await repos.support.addMessage(input);
      if (!written.ok) return { ok: false, error: publicError(written.error) };
      // A replay changed nothing, so it audits nothing. The entry names the request, never the text (R14).
      if (!written.replayed) {
        const audited = await repos.audit.record({
          action: "support.reply",
          targetType: "support_request",
          targetId: requestId,
        });
        if (!audited.ok) throw new Error("support: the audit entry was refused");
      }
      return { ok: true, id: written.value.id, replayed: written.replayed };
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** "Close request". Closing a closed request is a replay. */
export async function closeSupportRequestCore(
  deps: SupportThreadDeps,
  raw: unknown,
): Promise<SupportThreadResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const parsed = closeForm.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "validation", fields: fieldsOf(parsed.error) };
  const requestId = parsed.data.requestId as string;

  try {
    return await deps.store(session.customerId, async (repos): Promise<SupportThreadResult> => {
      const limit = await repos.rateLimits.consume(SUPPORT_CLOSE_LIMITS, deps.now());
      if (!limit.allowed) return { ok: false, error: "rate_limited" };

      const written = await repos.support.close(requestId);
      if (!written.ok) return { ok: false, error: publicError(written.error) };
      if (!written.replayed) {
        const audited = await repos.audit.record({
          action: "support.close",
          targetType: "support_request",
          targetId: requestId,
        });
        if (!audited.ok) throw new Error("support: the audit entry was refused");
      }
      return { ok: true, id: written.value.id, replayed: written.replayed };
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
