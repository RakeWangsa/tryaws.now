import { isPlainDecimal, isPositiveDecimal } from "./decimal";
import type { PriceQuote } from "./types";

export const SNAPSHOT_VERSION = 1;

/**
 * What an order stores about its price (version 1). Money is whole minor units as text, because JSON has no bigint.
 * `pricedAt` is the instant that chose the rate and the rule.
 */
export interface PriceSnapshot {
  v: 1;
  currency: "BDT";
  pricedAt: string;
  awsPriceUsd: string;
  quantity: string;
  fxRate: string;
  ruleVersion: string;
  baseMinor: string;
  steps: { code: string; amountMinor: string }[];
  totalMinor: string;
}

/** Thrown for every snapshot that is refused. `field` says where; the message holds no value. */
export class SnapshotError extends RangeError {
  readonly field: string;
  constructor(field: string, problem: string) {
    super(`price snapshot: ${field} ${problem}`);
    this.name = "SnapshotError";
    this.field = field;
  }
}

const KEYS = [
  "v",
  "currency",
  "pricedAt",
  "awsPriceUsd",
  "quantity",
  "fxRate",
  "ruleVersion",
  "baseMinor",
  "steps",
  "totalMinor",
] as const;
const STEP_KEYS = ["code", "amountMinor"] as const;
const MINOR_TEXT = /^(?:0|[1-9]\d*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function minorText(value: unknown, field: string): string {
  if (typeof value !== "string" || !MINOR_TEXT.test(value)) {
    throw new SnapshotError(field, "must be whole minor units as text");
  }
  return value;
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SnapshotError(field, "must be non-empty text");
  }
  return value;
}

function parseStep(raw: unknown, i: number): { code: string; amountMinor: string } {
  const at = `steps[${i}]`;
  if (!isRecord(raw)) throw new SnapshotError(at, "must be an object");
  for (const key of Object.keys(raw)) {
    if (!(STEP_KEYS as readonly string[]).includes(key)) {
      throw new SnapshotError(at, "has a field other than code and amountMinor");
    }
  }
  for (const key of STEP_KEYS) {
    if (!Object.hasOwn(raw, key)) throw new SnapshotError(`${at}.${key}`, "is missing");
  }
  return {
    code: nonEmptyText(raw.code, `${at}.code`),
    amountMinor: minorText(raw.amountMinor, `${at}.amountMinor`),
  };
}

/** Returns a copy of a valid version 1 snapshot, or throws SnapshotError naming the field. */
export function parseSnapshot(json: unknown): PriceSnapshot {
  if (!isRecord(json)) throw new SnapshotError("snapshot", "must be an object");
  for (const key of Object.keys(json)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      throw new SnapshotError(key, "is not a field of version 1");
    }
  }
  for (const key of KEYS) {
    if (!Object.hasOwn(json, key)) throw new SnapshotError(key, "is missing");
  }
  if (json.v !== SNAPSHOT_VERSION) throw new SnapshotError("v", "must be 1");
  if (json.currency !== "BDT") throw new SnapshotError("currency", "must be BDT");

  const pricedAt = json.pricedAt;
  if (
    typeof pricedAt !== "string" ||
    Number.isNaN(new Date(pricedAt).getTime()) ||
    new Date(pricedAt).toISOString() !== pricedAt
  ) {
    throw new SnapshotError("pricedAt", "must be an ISO instant in canonical form");
  }
  const awsPriceUsd = json.awsPriceUsd;
  if (!isPlainDecimal(awsPriceUsd)) {
    throw new SnapshotError("awsPriceUsd", "must be plain decimal text");
  }
  const quantity = json.quantity;
  if (!isPlainDecimal(quantity)) throw new SnapshotError("quantity", "must be plain decimal text");
  const fxRate = json.fxRate;
  if (!isPositiveDecimal(fxRate)) {
    throw new SnapshotError("fxRate", "must be plain decimal text above 0");
  }
  const ruleVersion = nonEmptyText(json.ruleVersion, "ruleVersion");
  const baseMinor = minorText(json.baseMinor, "baseMinor");
  if (!Array.isArray(json.steps)) throw new SnapshotError("steps", "must be a list");
  const steps = json.steps.map((raw: unknown, i: number) => parseStep(raw, i));
  const totalMinor = minorText(json.totalMinor, "totalMinor");

  const sum = steps.reduce((acc, s) => acc + BigInt(s.amountMinor), BigInt(baseMinor));
  if (sum !== BigInt(totalMinor)) {
    throw new SnapshotError("totalMinor", "must be the base plus every step");
  }
  return {
    v: SNAPSHOT_VERSION,
    currency: "BDT",
    pricedAt,
    awsPriceUsd,
    quantity,
    fxRate,
    ruleVersion,
    baseMinor,
    steps,
    totalMinor,
  };
}

/** The snapshot of a quote. `quantity` is "1" when not given. The result has passed parseSnapshot. */
export function toSnapshot(
  quote: PriceQuote,
  input: { awsPriceUsd: string; quantity?: string; pricedAt: Date },
): PriceSnapshot {
  if (Number.isNaN(input.pricedAt.getTime())) {
    throw new SnapshotError("pricedAt", "must be a valid instant");
  }
  return parseSnapshot({
    v: SNAPSHOT_VERSION,
    currency: quote.currency,
    pricedAt: input.pricedAt.toISOString(),
    awsPriceUsd: input.awsPriceUsd,
    quantity: input.quantity ?? "1",
    fxRate: quote.fxRate,
    ruleVersion: quote.ruleVersion,
    baseMinor: quote.baseMinor.toString(),
    steps: quote.steps.map((s) => ({ code: s.code, amountMinor: s.amountMinor.toString() })),
    totalMinor: quote.totalMinor.toString(),
  });
}

/** Checks the snapshot with parseSnapshot, then turns the amounts back into bigint. */
export function snapshotToQuote(snapshot: PriceSnapshot): PriceQuote {
  const s = parseSnapshot(snapshot);
  return {
    currency: s.currency,
    fxRate: s.fxRate,
    ruleVersion: s.ruleVersion,
    baseMinor: BigInt(s.baseMinor),
    steps: s.steps.map((x) => ({ code: x.code, amountMinor: BigInt(x.amountMinor) })),
    totalMinor: BigInt(s.totalMinor),
  };
}
