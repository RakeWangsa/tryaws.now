import { z } from "zod";
import type { Minor } from "../types";
import type { BookTerms } from "./book";
import { D, isPlainDecimal, isPositiveDecimal, parseDecimal, toMinor } from "./decimal";
import type { PriceSnapshot } from "./snapshot";
import type { PriceQuote } from "./types";

// WPU-Y2 (owner decision, second round, 1 and 4a). Every charge (purchase, renewal, metered) stores the
// exact price inputs it used, in ONE versioned structure, in the same transaction as its ledger posting
// (ledger_transactions.price_snapshot). Invoices and credit notes are rebuilt from this saved charge and
// never recalculated. The invoice is in BDT only; the USD inputs stay here for audit and are never printed.
//
// Money is whole paisa as text (JSON has no bigint). The decimal math of the engine is in quote.ts; the one
// check here (chargeSnapshotMatchesInputs) is the same half-up formula and sits in the pricing folder (R4).

export const CHARGE_SNAPSHOT_VERSION = 1;

/** Thrown for every charge snapshot that is refused. `field` says where; the message holds no value. */
export class ChargeSnapshotError extends RangeError {
  readonly field: string;
  constructor(field: string, problem: string) {
    super(`charge snapshot: ${field} ${problem}`);
    this.name = "ChargeSnapshotError";
    this.field = field;
  }
}

const MINOR = /^(?:0|[1-9]\d*)$/;
const minorText = z.string().regex(MINOR);
const plain = z.string().refine((s) => isPlainDecimal(s));
const positive = z.string().refine((s) => isPositiveDecimal(s));
const instant = z.string().refine((s) => {
  const t = new Date(s);
  return !Number.isNaN(t.getTime()) && t.toISOString() === s;
});
const amount = z.object({ kind: z.enum(["percent", "fixed"]), value: plain }).strict();

const stepSchema = z
  .object({ code: z.string().min(1), amountMinor: minorText, rate: plain.optional() })
  .strict();

const chargeSnapshotSchema = z
  .object({
    schemaVersion: z.literal(CHARGE_SNAPSHOT_VERSION),
    kind: z.enum(["purchase", "renewal", "metered"]),
    currency: z.literal("BDT"),
    pricedAt: instant,
    /** The USD price per unit as the engine took it (AWS price; the markup is a step of the BDT side). */
    awsPriceUsd: plain,
    quantity: plain,
    fx: z.object({ id: z.string().min(1), rate: positive, effectiveFrom: instant }).strict(),
    rule: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
    /** The markup (margin) and commission of the price book in force, or null when the family has none. */
    book: z.object({ margin: amount, commission: amount.nullable() }).strict().nullable(),
    rounding: z.literal("half_up"),
    baseMinor: minorText,
    steps: z.array(stepSchema),
    totalMinor: minorText,
    meter: z
      .object({ metric: z.string().min(1), usage: plain, unitTotalMinor: minorText })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const sum = s.steps.reduce((a, x) => a + BigInt(x.amountMinor), BigInt(s.baseMinor));
    if (sum !== BigInt(s.totalMinor)) {
      ctx.addIssue({
        code: "custom",
        path: ["totalMinor"],
        message: "must be the base plus every step",
      });
    }
  });

export type ChargeSnapshot = z.infer<typeof chargeSnapshotSchema>;
export type ChargeKind = ChargeSnapshot["kind"];

/** What the engine used for one priced item (the caller reads these from the rows in force). */
export interface ChargeInputs {
  readonly pricedAt: Date;
  readonly awsPriceUsd: string;
  readonly quantity: string;
  readonly fx: { readonly id: string; readonly rate: string; readonly effectiveFrom: Date };
  readonly rule: { readonly id: string; readonly version: string };
  readonly book: BookTerms | null;
  readonly quote: PriceQuote;
}

export interface MeterInput {
  readonly metric: string;
  /** The usage the charge is for, plain decimal text (GB of a day, or hours). */
  readonly usage: string;
  /** The unit price as the engine quoted it, in paisa. */
  readonly unitTotalMinor: string;
}

/** The split of the charge itself when it is a share of the unit price (metering). */
export interface ChargeAmounts {
  readonly baseMinor: Minor;
  readonly steps: readonly { code: string; amountMinor: Minor; rate?: string }[];
  readonly totalMinor: Minor;
}

function toIssue(error: z.ZodError): ChargeSnapshotError {
  const first = error.issues[0];
  const field = first === undefined ? "snapshot" : first.path.join(".") || "snapshot";
  return new ChargeSnapshotError(field, "is not valid");
}

/** Returns a copy of a valid version 1 charge snapshot, or throws ChargeSnapshotError naming the field. */
export function parseChargeSnapshot(json: unknown): ChargeSnapshot {
  const parsed = chargeSnapshotSchema.safeParse(json);
  if (!parsed.success) throw toIssue(parsed.error);
  return parsed.data;
}

/**
 * The snapshot of one charge. `options.charge` replaces the amounts of the quote with the amounts of the
 * charge (a metered charge is a share of the unit price); without it the quote's amounts are used. The
 * result has passed parseChargeSnapshot.
 */
export function buildChargeSnapshot(
  kind: ChargeKind,
  inputs: ChargeInputs,
  options?: { meter?: MeterInput; charge?: ChargeAmounts },
): ChargeSnapshot {
  if (Number.isNaN(inputs.pricedAt.getTime()) || Number.isNaN(inputs.fx.effectiveFrom.getTime())) {
    throw new ChargeSnapshotError("pricedAt", "must be a valid instant");
  }
  // The inputs and the quote must be the same thing: a snapshot that names a rate or a rule the quote
  // did not use would be a false record.
  if (inputs.fx.rate !== inputs.quote.fxRate) {
    throw new ChargeSnapshotError("fx.rate", "is not the rate of the quote");
  }
  if (inputs.rule.version !== inputs.quote.ruleVersion) {
    throw new ChargeSnapshotError("rule.version", "is not the rule version of the quote");
  }
  const amounts = options?.charge ?? inputs.quote;
  return parseChargeSnapshot({
    schemaVersion: CHARGE_SNAPSHOT_VERSION,
    kind,
    currency: "BDT",
    pricedAt: inputs.pricedAt.toISOString(),
    awsPriceUsd: inputs.awsPriceUsd,
    quantity: inputs.quantity,
    fx: {
      id: inputs.fx.id,
      rate: inputs.fx.rate,
      effectiveFrom: inputs.fx.effectiveFrom.toISOString(),
    },
    rule: { id: inputs.rule.id, version: inputs.rule.version },
    book:
      inputs.book === null
        ? null
        : {
            margin: { kind: inputs.book.margin.kind, value: inputs.book.margin.value },
            commission:
              inputs.book.commission === null
                ? null
                : { kind: inputs.book.commission.kind, value: inputs.book.commission.value },
          },
    rounding: "half_up",
    baseMinor: amounts.baseMinor.toString(),
    steps: amounts.steps.map((s) => ({
      code: s.code,
      amountMinor: s.amountMinor.toString(),
      ...(s.rate === undefined ? {} : { rate: s.rate }),
    })),
    totalMinor: amounts.totalMinor.toString(),
    ...(options?.meter === undefined ? {} : { meter: options.meter }),
  });
}

export type ChargeSnapshotRead =
  | { state: "snapshot"; value: ChargeSnapshot }
  /** A charge from before WPU-Y2: no snapshot. Render from what exists; never recalculate. */
  | { state: "legacy" }
  /** A schema version this code does not know. Fails closed: not read as version 1. */
  | { state: "unsupported"; version: number }
  | { state: "invalid" };

/** Reads a stored value. null, undefined and {} are legacy; a damaged value is invalid (R16). */
export function readChargeSnapshot(json: unknown): ChargeSnapshotRead {
  if (json === null || json === undefined) return { state: "legacy" };
  if (typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    if (Object.keys(record).length === 0) return { state: "legacy" };
    const version = record["schemaVersion"];
    if (typeof version === "number" && version !== CHARGE_SNAPSHOT_VERSION) {
      return { state: "unsupported", version };
    }
  }
  const parsed = chargeSnapshotSchema.safeParse(json);
  return parsed.success ? { state: "snapshot", value: parsed.data } : { state: "invalid" };
}

/**
 * Recomputes the base from the saved inputs (aws price x quantity x rate x 100, half up) and compares it
 * with the saved base. A metered charge is a share of the unit price, so only its rate and sums are
 * checked (those are enforced by the parser); it is true when the snapshot parses.
 */
export function chargeSnapshotMatchesInputs(snapshot: ChargeSnapshot): boolean {
  const s = parseChargeSnapshot(snapshot);
  if (s.kind === "metered") return true;
  const base = toMinor(
    parseDecimal(s.awsPriceUsd, "awsPriceUsd")
      .times(parseDecimal(s.quantity, "quantity"))
      .times(new D(s.fx.rate))
      .times(100),
  );
  return base === BigInt(s.baseMinor);
}

/** The version 1 price snapshot view of a charge, which the invoice line builder takes. */
export function chargeToPriceSnapshot(snapshot: ChargeSnapshot): PriceSnapshot {
  const s = parseChargeSnapshot(snapshot);
  return {
    v: 1,
    currency: "BDT",
    pricedAt: s.pricedAt,
    awsPriceUsd: s.awsPriceUsd,
    quantity: s.quantity,
    fxRate: s.fx.rate,
    ruleVersion: s.rule.version,
    baseMinor: s.baseMinor,
    steps: s.steps.map((x) => ({
      code: x.code,
      amountMinor: x.amountMinor,
      ...(x.rate === undefined ? {} : { rate: x.rate }),
    })),
    totalMinor: s.totalMinor,
  };
}
