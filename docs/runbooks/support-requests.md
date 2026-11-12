# Support requests

Routine in Section M: first answer within 1 working hour in launch week (operations lead). The admin page is `/support` (role `support`).

## Trigger

A new row in `support_requests` (status `open`), from the public form or the signed-in form.

## Who

Operations lead; admins with the `support` role.

## Safe checks

1. `/support`: category, subject, related resource, status. The requester's address is masked in the list (R14).
2. Is the customer signed in? A signed-in request carries the customer id from the session; a visitor request carries a name and an email only.
3. Route by category: money to [payment-stuck-or-disputed.md](payment-stuck-or-disputed.md); provisioning to [provisioning-failed-and-dead-letter.md](provisioning-failed-and-dead-letter.md); KYC to [kyc-review.md](kyc-review.md); abuse to [abuse-notice-and-suspension.md](abuse-notice-and-suspension.md).

## Steps

1. `replyByEmail` (the text goes to the notification, not to the audit row). Keep one reply per question.
2. `closeRequest` when done.
3. The signed-in form core is `apps/web/server/support-actions.ts` (R9 order, rate limit of 5 per hour per customer, audit). Its customer repository writer is not built yet (JOURNEY.md, Needs decision); until it is, requests come from the public form only.

## Rollback

Reopen by a new request; closed is a status, no data is deleted.

## Log

Request id, category, time to first answer. No message text in logs.

## Must not

Put an AWS account id, ARN or raw AWS text into a reply; ask for passwords or full document numbers by email.
