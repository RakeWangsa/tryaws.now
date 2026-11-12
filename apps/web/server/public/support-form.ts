import type { LimitRule } from "@tc/db";
import { emailSubject, ipSubject } from "@tc/notify";
import { z } from "zod";
import {
  MESSAGE_FORBIDDEN,
  SINGLE_LINE_FORBIDDEN,
  SUPPORT_CATEGORIES,
} from "../support-request.ts";
import type { LimitAnswer } from "./notify-me.ts";
import { HONEYPOT_FIELD } from "./support-form-fields.ts";

// The public /support form (16.8, WPU-B6). A visitor has no session, so the R9 order is: authorize
// (own origin, a usable viewer address, a limiter key), validate (zod), honeypot, rate limit (hashed
// subjects, R14), execute (one idempotent insert, R7), audit (a structured line without the address,
// the name or the text). No captcha vendor: a hidden field that a person never fills, plus the limiter.
// A filled honeypot gets the same "done" answer as a real send and stores nothing, so a bot learns
// nothing. The form takes no phone number, no document number and no password (R14): the page says
// so. Fail closed: anything that cannot be decided refuses the action (R16). Plain functions of a
// context: the production wiring is app/[locale]/(public)/support/actions.ts.

export type PublicSupportError = "invalid" | "rate_limited" | "unavailable";

export type PublicSupportState =
  | { status: "idle" }
  | { status: "done" }
  | {
      status: "error";
      code: PublicSupportError;
      fields?: readonly string[];
      ref?: string;
      retryAfterSeconds?: number;
    };

export interface PublicSupportContext {
  /** The request names our own origin (R9). */
  sameOrigin(): boolean;
  /** The viewer address as CloudFront saw it; null when there is no usable one. */
  ip: string | null;
  /** The key of the limiter subjects; null when it is not configured. */
  limitKey: string | null;
  /** Eight hex characters the visitor can quote. */
  ref: string;
  limit(rules: readonly LimitRule[]): Promise<LimitAnswer>;
  create(input: {
    email: string;
    name: string | null;
    category: (typeof SUPPORT_CATEGORIES)[number];
    subject: string;
    message: string;
  }): Promise<{ ok: boolean; replayed: boolean }>;
  /** Event name and outcome code only: no address, no name, no text (R14). */
  log(event: string, reason: string): void;
}

const HOUR = 3600;

// One table, one place to change the numbers: 10 a network per hour, 3 an address per hour.
export const PUBLIC_SUPPORT_LIMITS = Object.freeze([
  { kind: "ip", action: "support.public", limit: 10, windowSeconds: HOUR },
  { kind: "email", action: "support.public", limit: 3, windowSeconds: HOUR },
] as const);

export { HONEYPOT_FIELD };
export const NAME_MAX = 100;
export const SUBJECT_MAX = 120;
export const MESSAGE_MAX = 5000;

const singleLine = (max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((value) => !SINGLE_LINE_FORBIDDEN.test(value)),
    );

export const publicSupportForm = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email())
    .transform((value) => value.toLowerCase()),
  name: z
    .union([z.literal(""), z.string()])
    .transform((value) => value.normalize("NFC").trim())
    .pipe(z.union([z.literal(""), singleLine(NAME_MAX)]))
    .transform((value) => (value === "" ? null : value)),
  category: z.enum(SUPPORT_CATEGORIES),
  subject: singleLine(SUBJECT_MAX),
  message: z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(MESSAGE_MAX)
        .refine((value) => !MESSAGE_FORBIDDEN.test(value)),
    ),
});

const fail = (ctx: PublicSupportContext, code: PublicSupportError, extra?: object) =>
  ({ status: "error", code, ref: ctx.ref, ...extra }) as PublicSupportState;

export async function publicSupportCore(
  ctx: PublicSupportContext,
  form: Readonly<Record<string, unknown>>,
): Promise<PublicSupportState> {
  // 2. authorize
  if (!ctx.sameOrigin() || ctx.ip === null || ctx.limitKey === null) {
    return fail(ctx, "unavailable");
  }

  // 3. validate: the error names the fields, never the text of a zod issue.
  const parsed = publicSupportForm.safeParse({
    email: form["email"] ?? "",
    name: form["name"] ?? "",
    category: form["category"],
    subject: form["subject"],
    message: form["message"],
  });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))];
    return fail(ctx, "invalid", { fields: fields.filter((f) => f !== "") });
  }

  // The honeypot: a person never sees this field. The answer is the one of a real send.
  const trap = form[HONEYPOT_FIELD];
  if (typeof trap === "string" && trap !== "") {
    ctx.log("support.public", "honeypot");
    return { status: "done" };
  }

  // 4. rate limit
  const ip = ipSubject(ctx.limitKey, ctx.ip);
  const mail = emailSubject(ctx.limitKey, parsed.data.email);
  if (ip === null || mail === null) return fail(ctx, "unavailable");
  const rules: LimitRule[] = PUBLIC_SUPPORT_LIMITS.map((row) => ({
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

  // 5. execute, 6. audit: a repeated request is a replay with the same answer (R7).
  try {
    const written = await ctx.create(parsed.data);
    if (!written.ok) {
      ctx.log("support.public", "invalid");
      return fail(ctx, "invalid");
    }
    ctx.log("support.public", written.replayed ? "replayed" : "ok");
    return { status: "done" };
  } catch {
    ctx.log("support.public", "failed");
    return fail(ctx, "unavailable");
  }
}
