export type LedgerErrorCode = "no_wallet" | "invariant";

const MESSAGES: Record<LedgerErrorCode, string> = {
  no_wallet: "ledger: the customer has no wallet",
  invariant: "ledger: an invariant of the posting failed; the transaction is rolled back",
};

/** Thrown, never returned. The message is a constant of the code and holds no value (R14). */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode) {
    super(MESSAGES[code]);
    this.name = "LedgerError";
    this.code = code;
  }
}
