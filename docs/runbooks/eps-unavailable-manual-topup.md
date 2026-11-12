# EPS unavailable: manual top-up

Section M: "EPS unavailable (manual top-up by a `finance` admin with a bank or wallet receipt)". Rules: R5, R10, R13 not involved; wallet changes are real money.

## Trigger

- EPS GetToken or InitializeEPS fails for many customers (payments marked `failed` at once), or EPS is announced as down.
- A customer holds a bank or wallet receipt for money sent to TiCON outside the gateway.

## Who

Finance admin creates the adjustment; a second finance or superadmin approves above the limit (the requester can never approve their own).

## Safe checks

1. Is it really EPS? Look for `payments_sweep_failed` in the `payments-sweeper` log group and failed payments on `/payments`. Retry later before posting by hand: a pending payment may still verify.
2. The receipt shows our bank or wallet account, the amount and a reference. Check that the reference was not used before: search `/audit` and `/wallets/[customerId]` for it.
3. Check the customer on `/customers/[id]` (status, KYC).

## Steps

1. `/wallets/[customerId]`, `createAdjustment`: a credit, the BDT amount from the receipt, and as reason "manual top-up, receipt <reference>" (reference only, no account numbers).
2. Below the limit it posts at once (debit `adjustments`, credit `customer_wallet`). Above the limit it waits as `pending` until a second admin runs `approveAdjustment` or `rejectAdjustment`.
3. Tell the customer. Keep the receipt where the finance team keeps its bank records, not in the repository.
4. When EPS is back, check that a late EPS success for the same money did not also credit the wallet: look for a `topup:<payment id>` transaction next to the adjustment and reverse one of them (see [payment-stuck-or-disputed.md](payment-stuck-or-disputed.md)).

## Rollback

`createAdjustment` as a debit with the reason "reverse manual top-up <id>". Never delete the first posting (R5).

## Log

Adjustment id, amount, receipt reference, requester, approver. Never the full phone or email of the customer (R14).

## Must not

Credit a wallet from a screenshot nobody checked; credit without a reason; approve your own adjustment; touch the ledger tables directly.
