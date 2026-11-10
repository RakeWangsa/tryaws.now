export interface PricingProblem {
  /** Where the problem is: "awsPriceUsd", "fxRate", "quantity", "version", "steps", "steps[2].rate", or "" for the rule itself. */
  path: string;
  message: string;
}

/** Thrown by quote() for any input it refuses. It is a RangeError, so existing callers that catch RangeError still work. */
export class PricingInputError extends RangeError {
  readonly problems: readonly PricingProblem[];
  constructor(message: string, problems: readonly PricingProblem[]) {
    super(message);
    this.name = "PricingInputError";
    this.problems = problems;
  }
}
