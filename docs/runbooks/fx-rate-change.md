# FX rate change

Rules: R4 (money is bigint paisa; decimal math only in `packages/core/pricing`; half-up rounding), R5 (`fx_rates` and `pricing_rules` are append-only), R10.

## Trigger

The USD to BDT rate that TryAWS.now charges must change (the market moved, or the owner decides on a new rate). Prices of existing subscriptions are not changed by a new rate; renewals use "today's rate" (Section 11).

## Who

Finance admin asks; EVERY rate (WPU-Y1, owner decision) is approved by a different admin, never the one who asked. Rates are posted by person, never by a script and never by a feed. A rate of more than 10 percent away from the one in force needs the confirm box from both admins; a rate outside the range of its market (BD: 50 to 500) is refused.

## Maximum age (WPU-Y1)

A rate is good for 7 days from its start. After 6 days the daily alert `fx_rate_stale_warning` fires and `/pricing` shows a warning. After 7 days new purchases are refused with "prices are being updated", renewals and usage charges are held (not dropped, not double charged) and are charged from the old period end once a new rate is approved. To keep the same rate, ask for the same value again: it is a re-confirm and restarts the 7 days.

## Safe checks

1. `/pricing`: read the FX history and the current rate per market.
2. Before saving, open the preview of five products. It prices them with the real pricing engine at the new rate. Compare with a hand calculation of one product.
3. Check the size of the change against the limit shown by the screen. A large change needs the second admin.

## Steps

1. `/pricing`, `setFxRate`: new rate, effective time, reason.
2. If the change is large it waits for approval; the approver reads the five-product preview and approves or rejects.
3. After it is active, check `/pricing` history shows one new row and that a new draft order shows the new price. Customers with an open draft see `price_changed` and must accept the new total.
4. Tell support the new rate and the time.

## Rollback

Append a new rate row with the old value and the reason "revert". Never edit a row (append-only).

## Log

Old rate, new rate, effective time, requester, approver, reason. Rates are not secret.

## Must not

Use floats or spreadsheet rounding for the stored rate; change a price of an existing subscription; skip the preview.
