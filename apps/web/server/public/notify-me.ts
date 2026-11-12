import { parseEmailForm } from "@tc/core";
import type { LimitRule } from "@tc/db";
import { emailSubject, ipSubject } from "@tc/notify";
import { familyPageOf } from "./indexing.ts";

// "Notify me" on the page of a product whose flag is off (16.8, WPP-T4). A visitor has no session, so
// the R9 order is: authorize (own origin, a usable viewer address, a limiter key), validate (zod form
// of @tc/core, a family from the closed list), rate limit (hashed subjects, R14), execute (the flag
// is still off, then one idempotent insert, R7), audit (a structured line without the address).
// Fail closed: anything that cannot be decided refuses the action (R16). Plain functions of a
// context: the production wiring is app/[locale]/(public)/products/[family]/actions.ts.

export type NotifyMeError = "invalid" | "rate_limited" | "unavailable";

export type NotifyMeState =
  | { status: "idle" }
  | { status: "done" }
  | { status: "error"; code: NotifyMeError; ref?: string; retryAfterSeconds?: number };

export type LimitAnswer = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface NotifyMeContext {
  /** The request names our own origin (R9). */
  sameOrigin(): boolean;
  /** The viewer address as CloudFront saw it; null when there is no usable one. */
  ip: string | null;
  /** The key of the limiter subjects; null when it is not configured. */
  limitKey: string | null;
  /** Eight hex characters the visitor can quote. */
  ref: string;
  limit(rules: readonly LimitRule[]): Promise<LimitAnswer>;
  /** The stored value of the product flag: true = open, false = off, null = cannot be read. */
  flag(key: string): Promise<boolean | null>;
  join(input: {
    email: string;
    productFamily: string;
  }): Promise<{ ok: boolean; replayed: boolean }>;
  /** Event name and outcome code only: no address, no address of a network (R14). */
  log(event: string, reason: string): void;
}

const HOUR = 3600;

// One table, one place to change the numbers: 10 a network per hour, 3 an address per hour.
export const NOTIFY_ME_LIMITS = Object.freeze([
  { kind: "ip", action: "waitlist.join", limit: 10, windowSeconds: HOUR },
  { kind: "email", action: "waitlist.join", limit: 3, windowSeconds: HOUR },
] as const);

const fail = (ctx: NotifyMeContext, code: NotifyMeError, extra?: object): NotifyMeState => ({
  status: "error",
  code,
  ref: ctx.ref,
  ...extra,
});

export async function notifyMeCore(
  ctx: NotifyMeContext,
  form: Readonly<Record<string, unknown>>,
): Promise<NotifyMeState> {
  // 2. authorize
  if (!ctx.sameOrigin() || ctx.ip === null || ctx.limitKey === null) {
    return fail(ctx, "unavailable");
  }

  // 3. validate
  const parsed = parseEmailForm(form);
  const slug = form["family"];
  const page = typeof slug === "string" ? familyPageOf(slug) : null;
  if (!parsed.ok || page === null) return fail(ctx, "invalid");
  const { email } = parsed.value;

  // The product must still be off: a page that is open has nothing to wait for (R12).
  const open = await ctx.flag(page.flag).catch(() => null);
  if (open !== false) return fail(ctx, "unavailable");

  // 4. rate limit
  const ip = ipSubject(ctx.limitKey, ctx.ip);
  const mail = emailSubject(ctx.limitKey, email);
  if (ip === null || mail === null) return fail(ctx, "unavailable");
  const rules: LimitRule[] = NOTIFY_ME_LIMITS.map((row) => ({
    kind: row.kind,
    subject: row.kind === "ip" ? ip : mail,
    action: row.action,
    limit: row.limit,
    windowSeconds: row.windowSeconds,
  }));
  const answer = await ctx
    .limit(rules)
    .catch((): LimitAnswer => ({ allowed: false, retryAfterSeconds: 60 }));
  if (!answer.allowed) {
    return fail(ctx, "rate_limited", { retryAfterSeconds: answer.retryAfterSeconds });
  }

  // 5. execute, 6. audit: a repeated address and family is a replay with the same answer (R7).
  try {
    const written = await ctx.join({ email, productFamily: page.flag });
    if (!written.ok) {
      ctx.log("waitlist.join", "invalid");
      return fail(ctx, "invalid");
    }
    ctx.log("waitlist.join", "ok");
    return { status: "done" };
  } catch {
    ctx.log("waitlist.join", "failed");
    return fail(ctx, "unavailable");
  }
}
