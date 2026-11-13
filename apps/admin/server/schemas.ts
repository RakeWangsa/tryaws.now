import { z } from "zod";

// WPU-B6 (item 28): the zod schemas of the admin app. Step 3 of R9 (validate) for every Server Action
// and route of apps/admin goes through here. Pure: no next/* import, no I/O. A schema answers with the
// cleaned value or nothing, and the flows turn "nothing" into their fixed `invalid` code: no zod
// message or issue path ever reaches an answer, a log or the page (R14, R16).

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MARKET_PATTERN = /^[A-Z]{2}$/;
export const BLUEPRINT_PATTERN = /^[a-z0-9_]{1,64}$/;
export const EMAIL_PATTERN =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
export const MAX_REASON_LENGTH = 500;

export const uuidText = z.string().regex(UUID_PATTERN);
export const uuid = uuidText.transform((value) => value.toLowerCase());
export const market = z.string().regex(MARKET_PATTERN);
export const blueprintId = z.string().regex(BLUEPRINT_PATTERN);

// A required text: trimmed, not empty, at most `max` characters after trimming.
export const text = (max: number) => z.string().trim().min(1).max(max);
// R10: the reason of every admin action.
export const reason = text(MAX_REASON_LENGTH);

// An optional text. Missing, null or "" is "nothing"; a longer raw value is refused; blank is "nothing".
export const optionalText = (max: number) =>
  z
    .union([z.undefined(), z.null(), z.literal(""), z.string().max(max)])
    .transform((value) =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : undefined,
    )
    .optional();

// A whole number from a form: digits only, no sign, no exponent, no float; a JS number is its text.
export const wholeNumber = (min: number, max: number) =>
  z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().regex(/^[0-9]{1,9}$/))
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(min).max(max));

// The answer of every check: the cleaned value or null.
export function check<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const isUuid = (value: unknown): value is string => uuidText.safeParse(value).success;
export const isMarket = (value: unknown): value is string => market.safeParse(value).success;
export const isBlueprintId = (value: unknown): value is string =>
  blueprintId.safeParse(value).success;

// ---- customer decisions (/customers/[id]) ----
export const CUSTOMER_KINDS = [
  "approveKyc",
  "rejectKyc",
  "setRiskTier",
  "suspend",
  "resume",
] as const;
export const RISK_TIERS = ["new", "trusted"] as const;

export const customerAction = z
  .object({
    kind: z.enum(CUSTOMER_KINDS),
    id: uuidText,
    reason,
    note: optionalText(500),
    tier: z.unknown().optional(),
  })
  .transform((value, ctx) => {
    const tier = z.enum(RISK_TIERS).safeParse(value.tier);
    if (value.kind === "setRiskTier" && !tier.success) {
      ctx.addIssue({ code: "custom", message: "tier" });
      return z.NEVER;
    }
    return {
      kind: value.kind,
      id: value.id,
      reason: value.reason,
      note: value.note,
      tier: value.kind === "setRiskTier" && tier.success ? tier.data : undefined,
    };
  });

// ---- admin directory (/admins) ----
export const ADMIN_ROLE_VALUES = ["support", "finance", "ops", "superadmin"] as const;
export const ADMINS_KINDS = [
  "inviteAdmin",
  "setAdminRole",
  "disableAdmin",
  "enableAdmin",
  "resetAdminMfa",
] as const;

export const adminsAction = z
  .object({
    kind: z.enum(ADMINS_KINDS),
    reason,
    id: z.unknown().optional(),
    email: z.unknown().optional(),
    role: z.unknown().optional(),
  })
  .transform((value, ctx) => {
    const fail = () => {
      ctx.addIssue({ code: "custom", message: "admins" });
      return z.NEVER;
    };
    let id: string | null = null;
    let email: string | null = null;
    let role: (typeof ADMIN_ROLE_VALUES)[number] | null = null;
    if (value.kind === "inviteAdmin") {
      const parsed = z
        .string()
        .trim()
        .toLowerCase()
        .max(254)
        .regex(EMAIL_PATTERN)
        .safeParse(value.email);
      if (!parsed.success) return fail();
      email = parsed.data;
    } else {
      const parsed = uuid.safeParse(value.id);
      if (!parsed.success) return fail();
      id = parsed.data;
    }
    if (value.kind === "inviteAdmin" || value.kind === "setAdminRole") {
      const parsed = z.enum(ADMIN_ROLE_VALUES).safeParse(value.role);
      if (!parsed.success) return fail();
      role = parsed.data;
    }
    return { kind: value.kind, reason: value.reason, id, email, role };
  });

// ---- operations (/operations/[id]) and the plan-change mark ----
export const OPS_KINDS = ["approveOperation", "rejectOperation", "retryOperation"] as const;

export const opsAction = z.object({ kind: z.enum(OPS_KINDS), id: uuid, reason });

export const planMarkAction = z.object({ resourceId: uuid, requestId: uuid, reason });

// ---- one reasoned action on one row (reconciliation, abuse case ids, support) ----
export const reasonedId = z.object({ id: uuid, reason });

// ---- money (/wallets, /payments) ----
export const MONEY_DIRECTIONS = ["credit", "debit"] as const;
export const MONEY_ADJUSTMENT_KINDS = ["goodwill", "deposit", "correction"] as const;
export const MAX_EVIDENCE_LENGTH = 200;

// Taka text to paisa with integer arithmetic only: one to fifteen whole digits and at most two
// decimals, above zero. No Number() anywhere near money (R4).
export const takaToMinor = z.string().transform((value, ctx) => {
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) {
    ctx.addIssue({ code: "custom", message: "amount" });
    return z.NEVER;
  }
  const minor = BigInt(match[1] as string) * 100n + BigInt(((match[2] ?? "") + "00").slice(0, 2));
  if (minor <= 0n) {
    ctx.addIssue({ code: "custom", message: "amount" });
    return z.NEVER;
  }
  return minor;
});

export const moneyEnvelope = z.object({ id: uuid, reason });

export const createAdjustment = z.object({
  customerId: uuid,
  direction: z.enum(MONEY_DIRECTIONS),
  adjustmentKind: z.enum(MONEY_ADJUSTMENT_KINDS),
  evidence: optionalText(MAX_EVIDENCE_LENGTH),
  amount: takaToMinor,
});

export const manualRefund = z.object({ amount: takaToMinor });

// ---- capacity (/capacity) ----
export const REGION_PATTERN = /^(?:global|[a-z]{2}(?:-[a-z]+)+-[0-9])$/;
export const FAMILY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const CAPACITY_KINDS = ["setCapacityLimit", "notifyWaitlist"] as const;
export const LIMIT_MAX = 1_000_000;
export const COUNT_MAX = 100;

export const capacityEnvelope = z.object({
  kind: z.enum(CAPACITY_KINDS),
  reason,
  region: z.string().regex(REGION_PATTERN),
});

export const capacityLimit = (quotaCodes: readonly [string, ...string[]]) =>
  z.object({
    poolAccountId: uuid,
    quotaCode: z.enum(quotaCodes),
    limit: wholeNumber(0, LIMIT_MAX),
  });

export const capacityWaitlist = z.object({
  productFamily: z.string().regex(FAMILY_PATTERN),
  waitlistReason: z.enum(["capacity", "flag_off"]),
  count: wholeNumber(1, COUNT_MAX),
});

// ---- the two routes with a request of their own ----
// /api/audit-export: the filter of the audit view is parsed by audit-query.ts; the export needs, in
// addition, the reason of R10 (one text, never a list).
export const auditExportParams = z.object({ reason });

// /api/kyc-document/[submissionId]/[index]: a UUID, a one or two digit index and the reason of R10.
export const kycDocumentParams = z.object({
  reason,
  submissionId: uuidText,
  index: z.union([
    z
      .string()
      .regex(/^[0-9]{1,2}$/)
      .transform(Number),
    z.number().int().min(0),
  ]),
});

// /api/csp-report: a report is small JSON; the body is capped before it is parsed.
export const CSP_REPORT_MAX_BYTES = 16_384;
export const cspReportBody = z.union([z.array(z.unknown()), z.looseObject({})]);

// ---- sign-in (/login) ----
export const signInForm = z.object({
  email: z.string().max(254),
  password: z.string().max(1024),
  code: z.string().max(32),
});

// ---- the form fields that choose a redirect: a UUID or nothing ----
export const redirectId = z.string().regex(UUID_PATTERN);
