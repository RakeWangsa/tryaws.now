import { listCatalogProductsForAdmin, type Tx } from "@tc/db";
import {
  PricingInputError,
  isBookTerms,
  isPlainDecimal,
  problemFields,
  quoteWithBook,
  validateBookTerms,
  type BookTerms,
} from "../pricing/index";
import { isFeatureFlag } from "../flags/keys";
import type { Clock, Minor, Result } from "../types";
import { pricingInForce } from "./in-force";

/** What one product costs a customer under some terms: the engine's answer, in paisa. */
export interface BookedFigures {
  baseMinor: Minor;
  marginMinor: Minor;
  commissionMinor: Minor;
  totalMinor: Minor;
}

export interface BookPreviewRow {
  /** The catalog row id, or `sample_<n>` when the family has no catalog row. */
  productId: string;
  region: string;
  awsId: string;
  billingUnit: string;
  active: boolean;
  /** The AWS base cost the candidate uses (text, USD for one billing unit). */
  awsPriceUsd: string;
  /** The AWS base cost stored now. */
  currentAwsPriceUsd: string;
  current: BookedFigures | null;
  candidate: BookedFigures;
  /** Candidate total minus current total. */
  deltaMinor: Minor | null;
}

export interface BookPreview {
  fxRate: string;
  /** True when the family has no catalog row and three sample products stand in. */
  fromSamples: boolean;
  rows: BookPreviewRow[];
}

// A family with no catalog row (backups, domains, ...) is shown on three sample plans.
const SAMPLES = ["5", "24", "84"] as const;

const figures = (b: ReturnType<typeof quoteWithBook>): BookedFigures => ({
  baseMinor: b.quote.baseMinor,
  marginMinor: b.marginMinor,
  commissionMinor: b.commissionMinor,
  totalMinor: b.quote.totalMinor,
});

/**
 * The live preview of the price list for one family: every product priced by the engine
 * (`quoteWithBook`, the function that prices an order) under the terms in force and under the
 * candidate. `terms` undefined keeps the terms in force; `null` is no margin at all. `base` tries
 * another AWS base cost on one product. It computes nothing of its own and writes nothing. No rate or
 * rule in force, and nothing is priced (R16).
 */
export async function previewBook(
  tx: Tx,
  input: {
    market: string;
    productFamily: string;
    terms?: BookTerms | null;
    base?: { productId: string; awsPriceUsd: string };
  },
  clock: Clock,
): Promise<Result<BookPreview>> {
  const { market, productFamily, terms, base } = input;
  if (!isFeatureFlag(productFamily)) {
    return { ok: false, error: "validation", fields: { family: "unknown" } };
  }
  const fields: Record<string, string> = {};
  if (terms !== undefined && terms !== null && !isBookTerms(terms)) {
    Object.assign(fields, problemFields(validateBookTerms(terms)));
  }
  if (base !== undefined && !(isPlainDecimal(base.awsPriceUsd) && /[1-9]/.test(base.awsPriceUsd))) {
    fields.awsPriceUsd = "invalid";
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };

  const found = await pricingInForce(tx, { market, productFamily }, clock, { allowStale: true });
  if (!found.ok) return found;
  const { fx, rule, book } = found.value;
  const candidateTerms = terms === undefined ? book : terms;

  const catalog = await listCatalogProductsForAdmin(tx, { family: productFamily });
  const products =
    catalog.length > 0
      ? catalog.map((c) => ({
          productId: c.id,
          region: c.region,
          awsId: c.awsId,
          billingUnit: c.billingUnit,
          active: c.active,
          awsPriceUsd: c.awsPriceUsd,
        }))
      : SAMPLES.map((usd, i) => ({
          productId: `sample_${i + 1}`,
          region: "",
          awsId: "",
          billingUnit: "month",
          active: true,
          awsPriceUsd: usd as string,
        }));
  if (base !== undefined && !products.some((p) => p.productId === base.productId)) {
    return { ok: false, error: "validation", fields: { product: "unknown" } };
  }

  try {
    const rows = products.map((p): BookPreviewRow => {
      const candidateUsd =
        base !== undefined && base.productId === p.productId ? base.awsPriceUsd : p.awsPriceUsd;
      const price = (awsPriceUsd: string, at: BookTerms | null) =>
        figures(quoteWithBook({ awsPriceUsd, fxRate: fx.rate, rule: rule.value }, at));
      const current = price(p.awsPriceUsd, book);
      const candidate = price(candidateUsd, candidateTerms);
      return {
        ...p,
        awsPriceUsd: candidateUsd,
        currentAwsPriceUsd: p.awsPriceUsd,
        current,
        candidate,
        deltaMinor: candidate.totalMinor - current.totalMinor,
      };
    });
    return { ok: true, value: { fxRate: fx.rate, fromSamples: catalog.length === 0, rows } };
  } catch (error) {
    if (error instanceof PricingInputError) {
      return { ok: false, error: "validation", fields: problemFields(error.problems) };
    }
    throw error;
  }
}
