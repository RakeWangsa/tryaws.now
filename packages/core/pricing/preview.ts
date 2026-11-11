import type { Minor, Result } from "../types";
import { isPositiveDecimal } from "./decimal";
import { PricingInputError, type PricingProblem } from "./errors";
import { quote } from "./quote";
import type { PriceQuote, PricingRule } from "./types";
import { validateRule } from "./validate";

export interface PreviewSample {
  /** A key for a label, not text for people. */
  id: string;
  family: string;
  awsPriceUsd: string;
  quantity?: string;
}

/** Five fixed samples (spec section 8, the admin editor). The catalog is empty until WP1-T5, so they are data. */
export const PREVIEW_SAMPLES: readonly PreviewSample[] = Object.freeze([
  Object.freeze({ id: "instance_5", family: "linux_instance", awsPriceUsd: "5" }),
  Object.freeze({ id: "instance_24", family: "linux_instance", awsPriceUsd: "24" }),
  Object.freeze({ id: "instance_84", family: "linux_instance", awsPriceUsd: "84" }),
  Object.freeze({ id: "disk_80gb", family: "disk", awsPriceUsd: "0.10", quantity: "80" }),
  Object.freeze({
    id: "backup_1gb_day",
    family: "backup",
    awsPriceUsd: "0.05",
    quantity: "0.0333333333",
  }),
]);

export interface PricingBasis {
  fxRate: string;
  rule: PricingRule;
}

export interface PreviewRow {
  sampleId: string;
  awsPriceUsd: string;
  /** "1" when the sample has no quantity. */
  quantity: string;
  candidate: PriceQuote;
  current: PriceQuote | null;
  /** Candidate total minus current total; null without a current basis. */
  deltaMinor: Minor | null;
}

export interface PricingPreview {
  rows: PreviewRow[];
}

/** Path to message; "" becomes "rule"; two messages for one path are joined with "; "; the prefix goes in front as given. */
export function problemFields(
  problems: readonly PricingProblem[],
  prefix = "",
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const { path, message } of problems) {
    const key = prefix + (path === "" ? "rule" : path);
    fields[key] = Object.hasOwn(fields, key) ? `${fields[key]}; ${message}` : message;
  }
  return fields;
}

/**
 * Prices every sample under the candidate basis (and the current one, when given) with quote(),
 * the function that prices an order, and computes nothing of its own.
 */
export function previewPricing(input: {
  candidate: PricingBasis;
  current?: PricingBasis | null;
  samples?: readonly PreviewSample[];
}): Result<PricingPreview> {
  const { candidate, current = null, samples = PREVIEW_SAMPLES } = input;

  const basisProblems: PricingProblem[] = validateRule(candidate.rule);
  if (!isPositiveDecimal(candidate.fxRate)) {
    basisProblems.push({ path: "fxRate", message: "fxRate must be plain decimal text above 0" });
  }
  if (basisProblems.length > 0) {
    return { ok: false, error: "validation", fields: problemFields(basisProblems) };
  }

  const rows: PreviewRow[] = [];
  const fields: Record<string, string> = {};
  for (const sample of samples) {
    const priced = (basis: PricingBasis) =>
      quote({
        awsPriceUsd: sample.awsPriceUsd,
        quantity: sample.quantity,
        fxRate: basis.fxRate,
        rule: basis.rule,
      });

    let candidateQuote: PriceQuote;
    try {
      candidateQuote = priced(candidate);
    } catch (error) {
      if (!(error instanceof PricingInputError)) throw error;
      Object.assign(fields, problemFields(error.problems, `${sample.id}.`));
      continue;
    }

    let currentQuote: PriceQuote | null = null;
    if (current !== null) {
      try {
        currentQuote = priced(current);
      } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ok: false, error: "internal" };
      }
    }

    rows.push({
      sampleId: sample.id,
      awsPriceUsd: sample.awsPriceUsd,
      quantity: sample.quantity ?? "1",
      candidate: candidateQuote,
      current: currentQuote,
      deltaMinor:
        currentQuote === null ? null : candidateQuote.totalMinor - currentQuote.totalMinor,
    });
  }

  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return { ok: true, value: { rows } };
}
