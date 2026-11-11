import { formatEpsAmount } from "./amount";
import type { EpsGateway, InitializeRequest, InitializeResult, VerifyResult } from "./gateway";
import { readVerifyResponse } from "./status";

/** Raw text a test wants EPS to answer with, so aliases and bad amounts go through the real parser. */
export interface SettleOutcome {
  status: string;
  totalAmount?: string;
  merchantTransactionId?: string;
  epsTransactionId?: string;
}

export type FailMode = "unavailable" | "throw" | "hang";

/** A planted secret: the service tests prove that nothing of an error text is passed on. */
const PLANTED = "planted-secret-hash-key-0123456789";

/** In-memory EPS for tests and local development. Refuses to be built elsewhere (fail closed). */
export class InMemoryEps implements EpsGateway {
  readonly initialized: InitializeRequest[] = [];
  readonly verifyCalls: string[] = [];
  private readonly accepted = new Map<string, { req: InitializeRequest; epsId: string }>();
  private readonly outcomes = new Map<string, SettleOutcome>();
  private failures: FailMode[] = [];
  private counter = 0;

  constructor() {
    const env = process.env.NODE_ENV;
    if (env !== "test" && env !== "development") {
      throw new Error("InMemoryEps is for tests and development only");
    }
  }

  reset(): void {
    this.initialized.length = 0;
    this.verifyCalls.length = 0;
    this.accepted.clear();
    this.outcomes.clear();
    this.failures = [];
    this.counter = 0;
  }

  /** The next `times` calls (initialize or verify, in call order) fail in this mode. */
  failNext(mode: FailMode, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(mode);
  }

  /** What EPS will say for this id from now on. The amount defaults to the amount of the initialized request. */
  settle(merchantTransactionId: string, outcome: SettleOutcome): void {
    this.outcomes.set(merchantTransactionId, outcome);
  }

  private async maybeFail(): Promise<"unavailable" | null> {
    const mode = this.failures.shift();
    if (mode === undefined) return null;
    if (mode === "unavailable") return "unavailable";
    if (mode === "throw") throw new Error(`gateway failed: ${PLANTED}`);
    return new Promise<never>(() => {});
  }

  async initialize(req: InitializeRequest): Promise<InitializeResult> {
    this.initialized.push(req);
    if ((await this.maybeFail()) === "unavailable") return { ok: false, reason: "unavailable" };
    if (
      req.merchantTransactionId.length < 10 ||
      this.accepted.has(req.merchantTransactionId) ||
      req.totalAmountMinor <= 0n
    ) {
      return { ok: false, reason: "rejected" };
    }
    this.counter += 1;
    const epsId = `eps-${this.counter}`;
    this.accepted.set(req.merchantTransactionId, { req, epsId });
    return {
      ok: true,
      redirectUrl: `https://pg.eps.test/PG?data=${this.counter}`,
      gatewayTransactionId: epsId,
    };
  }

  async verify(merchantTransactionId: string): Promise<VerifyResult> {
    this.verifyCalls.push(merchantTransactionId);
    if ((await this.maybeFail()) === "unavailable") return { ok: false, reason: "unavailable" };
    const known = this.accepted.get(merchantTransactionId);
    const outcome = this.outcomes.get(merchantTransactionId);
    // VERIFY (open point 6): an unknown or unsettled transaction answers pending.
    if (outcome === undefined) {
      return { ok: true, reading: readVerifyResponse({ Status: "Pending" }) };
    }
    const body: Record<string, unknown> = {
      Status: outcome.status,
      MerchantTransactionId: outcome.merchantTransactionId ?? merchantTransactionId,
    };
    const eps = outcome.epsTransactionId ?? known?.epsId;
    if (eps !== undefined) body.EpsTransactionId = eps;
    const amount =
      outcome.totalAmount ?? (known ? formatEpsAmount(known.req.totalAmountMinor) : undefined);
    if (amount !== undefined) body.TotalAmount = amount;
    return { ok: true, reading: readVerifyResponse(body) };
  }
}
