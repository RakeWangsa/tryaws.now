# Lifecycle approval

Section M: "lifecycle approval". Rule R13: destructive lifecycle actions need the right subscription state, a final snapshot where supported, and admin approval until 2026-12-01.

## Trigger

An operation in `needs_approval` on `/operations`: a destroy at the end of retention (period end + 48 hours), or another destructive action. The lifecycle job logs `lifecycle` and `lifecycle_run`.

## Who

Operations (`ops` role). The approver reads the evidence below; the audit row stores actor, reason, IP and target (R10).

## Safe checks (all before approving)

1. Subscription state is `retained`-bound: it was `grace` for 48 hours and the customer did not pay. Check `/customers/[id]` and the subscription.
2. The resource is not suspended by an admin for another reason (an abuse case): see [abuse-notice-and-suspension.md](abuse-notice-and-suspension.md).
3. The final snapshot exists and is `available` where the family supports one (instance, database, disk). Load balancer, container service, CDN and DNS keep their configuration in `resources.config` instead.
4. The wallet really cannot pay: no pending top-up (`/payments`) and no payment in `review`.
5. Today's date: before 2026-12-01 approval is required; after the owner removes that rule the steps stay the same.

## Steps

1. `approveOperation` with a reason, or `rejectOperation` to give the customer more time (the subscription state is then handled by the lifecycle job on its next run).
2. Watch the operation go `running` then `succeeded`; the state becomes `retained` and the customer is notified.
3. 14 days later the job purges snapshots and the state becomes `ended`; this also needs the matching approval while the rule lasts.

## Rollback

Destroy cannot be undone. If a customer pays during retention, restore from the final snapshot (new period starts at restore time). That is why every check above comes first.

## Log

Operation id, resource id, state, snapshot check, decision, admin.

## Must not

Approve without a final snapshot where one is supported; approve for a customer who paid in the last hour; let a renewal resume an admin-suspended resource.
