import type { Tx } from "../../client";

// packages/db sits below packages/core and never imports it, so an admin repository that has to post
// to the ledger (an approved adjustment, a manual refund) takes the poster as an argument. The admin
// app passes `postTransaction` of @tc/core, which checks the request again (kind, key family, actor,
// reason, balance) and posts it under the wallet lock (R5, 9.1). The shapes below are the ones of
// PostTransactionInput of @tc/core, narrowed to what the two admin postings use.
export interface LedgerPostRequest {
  readonly kind: "adjustment" | "refund";
  readonly reference: { readonly type: string; readonly id: string };
  // Derived on the server from an id (9.1): `adjustment:<request id>`, `refund:<payment id>`.
  readonly idempotencyKey: string;
  readonly actor: { readonly type: "admin"; readonly id: string };
  readonly memo: string;
  // A mutable array type, so that `postTransaction` of @tc/core is assignable to LedgerPoster.
  readonly postings: LedgerPostLine[];
}

export interface LedgerPostLine {
  readonly account:
    | { readonly type: "customer_wallet"; readonly customerId: string }
    | { readonly type: "adjustments" | "refunds" };
  readonly direction: "debit" | "credit";
  readonly amountMinor: bigint;
}

export type LedgerPostAnswer =
  | { readonly ok: true; readonly value: { readonly transactionId: string } }
  | { readonly ok: false; readonly error: string };

export type LedgerPoster = (tx: Tx, request: LedgerPostRequest) => Promise<LedgerPostAnswer>;

// WPU-M3: the reversal of a ledger transaction (`reverseTransaction` of @tc/core): the same lines
// reversed, once per original (R5). The admin repository passes the actor and the memo; core checks
// the request again and posts it under the wallet lock.
export interface LedgerReverseRequest {
  readonly transactionId: string;
  readonly actor: { readonly type: "admin"; readonly id: string };
  readonly memo: string;
}

export type LedgerReverser = (tx: Tx, request: LedgerReverseRequest) => Promise<LedgerPostAnswer>;
