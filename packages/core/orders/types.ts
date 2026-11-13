import type { PriceQuote, PriceSnapshot } from "../pricing/index";
import type { Locale } from "../types";

/** A draft token is valid for 30 minutes (16.11 step 2). */
export const DRAFT_TTL_SECONDS = 1800;
/** A token longer than this is refused before any decoding. */
export const DRAFT_MAX_BYTES = 4096;
/** The shape of a client idempotency key. */
export const CLIENT_KEY = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The session as the orders code sees it, declared here so that @tc/core does not import @tc/auth
 * (a CustomerSession is assignable). Only customerId and locale are used: kycStatus and riskTier
 * of the session are never an input of a decision, the database row is (R16).
 */
export interface OrderSession {
  readonly customerId: string;
  readonly kycStatus: "none" | "pending" | "verified" | "rejected";
  readonly riskTier: "new" | "trusted";
  readonly locale: Locale;
}

/** What a draft token holds. Nothing secret. Keys are listed in the order that is signed. */
export interface DraftClaims {
  readonly v: 1;
  readonly c: string;
  readonly fam: string;
  readonly pid: string;
  readonly region: string;
  readonly cfg: Readonly<Record<string, unknown>>;
  readonly snap: PriceSnapshot;
  /**
   * WPU-Y4: the exchange rate row that priced the draft (its id and the instant it took effect), shown on the
   * review page. Optional: a draft signed before had none. The price check compares the rate TEXT and the
   * amounts of `snap`, never this id, so setting the same rate again does not ask the customer to confirm again.
   */
  readonly fx?: { readonly id: string; readonly at: string };
  readonly iat: number;
  readonly exp: number;
}

export interface OrderDraft {
  readonly token: string;
  readonly quote: PriceQuote;
  readonly expiresAt: Date;
}
