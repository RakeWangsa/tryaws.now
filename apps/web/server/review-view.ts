import { snapshotToQuote } from "@tc/core";
import type { verifyDraft } from "@tc/core";
import { shortfallTopUpTaka } from "./servers-view.ts";

// What /orders/review shows, built from the signed draft token (16.11 step 3). The token is the only
// source of the price: nothing is priced again on this page, and the client adds nothing (R4).

/** What `verifyDraft` answers (the claims type itself is not exported by @tc/core). */
export type Verdict = ReturnType<typeof verifyDraft>;
export type Claims = Extract<Verdict, { ok: true }>["claims"];

export type ReviewScreen =
  | { state: "invalid" | "expired" | "unavailable" }
  | {
      state: "ready";
      token: string;
      name: string;
      region: string;
      productId: string;
      expiresAt: Date;
      baseMinor: bigint;
      steps: { code: string; amountMinor: bigint }[];
      totalMinor: bigint;
      balanceMinor: bigint;
      /** null when the balance covers the total */
      balanceAfterMinor: bigint | null;
      shortfallTaka: bigint | null;
    };

const MAX_TOKEN = 4096;

export function reviewFromToken(
  verify: (token: string) => Verdict,
  token: unknown,
  customerId: string,
  balanceMinor: bigint,
): ReviewScreen {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN) {
    return { state: "invalid" };
  }
  const verdict = verify(token);
  if (!verdict.ok) return { state: verdict.reason === "expired" ? "expired" : "invalid" };
  const claims = verdict.claims;
  // A token is accepted only from the customer it names; the answer does not say which check failed.
  if (claims.c !== customerId) return { state: "invalid" };

  let quote;
  try {
    quote = snapshotToQuote(claims.snap);
  } catch {
    return { state: "invalid" };
  }
  const cfg = claims.cfg as Record<string, unknown>;
  const shortfallTaka = shortfallTopUpTaka(quote.totalMinor, balanceMinor);
  return {
    state: "ready",
    token,
    name: typeof cfg["displayName"] === "string" ? cfg["displayName"].slice(0, 60) : "",
    region: claims.region,
    productId: claims.pid,
    expiresAt: new Date(claims.exp * 1000),
    baseMinor: quote.baseMinor,
    steps: quote.steps.map((s) => ({ code: s.code, amountMinor: s.amountMinor })),
    totalMinor: quote.totalMinor,
    balanceMinor,
    balanceAfterMinor: shortfallTaka === null ? balanceMinor - quote.totalMinor : null,
    shortfallTaka,
  };
}

export { topUpHref } from "./topup-link.ts";
