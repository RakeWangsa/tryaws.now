// WPU-X25. The price lines a CUSTOMER sees (owner decision of 2026-11-15: "Korea VAT label no need to mention,
// count should be there"). The amount of the korea_vat step stays in the price, but there is no line called
// Korea VAT: it is added to the first line, the AWS service price converted to taka. Only the presentation
// changes. The price rule, the snapshot, the ledger and the tax invoice keep every step under its own name
// (staff screens show them too), and the total the customer pays is the stored total to the paisa.
// Whole paisa as bigint, additions only (R4). Lines that do not add up are refused, never shown (R16).

export interface PriceStepLine {
  code: string;
  amountMinor: bigint;
}

export interface CustomerPriceLines<S extends PriceStepLine = PriceStepLine> {
  baseMinor: bigint;
  steps: S[];
  totalMinor: bigint;
}

/** The step that a customer screen does not name; its amount goes into the first line. */
export const FOLDED_INTO_BASE = "korea_vat";

function bigintOf(value: unknown, name: string): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`customerPriceLines: ${name} must be a bigint of paisa (R4)`);
  }
  return value;
}

/**
 * The base line with korea_vat added, the other steps in their order, the stored total.
 * Throws RangeError when base plus the steps is not the total.
 */
export function customerPriceLines<S extends PriceStepLine>(
  baseMinor: bigint,
  steps: readonly S[],
  totalMinor: bigint,
): CustomerPriceLines<S> {
  let base = bigintOf(baseMinor, "baseMinor");
  const total = bigintOf(totalMinor, "totalMinor");
  const shown: S[] = [];
  let sum = base;
  for (const step of steps) {
    const amount = bigintOf(step.amountMinor, `steps[${step.code}].amountMinor`);
    sum += amount;
    if (step.code === FOLDED_INTO_BASE) base += amount;
    else shown.push(step);
  }
  if (sum !== total) {
    throw new RangeError("customerPriceLines: the base plus the steps does not equal the total");
  }
  return { baseMinor: base, steps: shown, totalMinor: total };
}
