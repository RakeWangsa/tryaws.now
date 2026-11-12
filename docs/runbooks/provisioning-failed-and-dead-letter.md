# Provisioning failed and the dead-letter queue

Section M: "provisioning failed". Rules: R1 (web and admin only write an operation row and enqueue), R3, R7 (every step is idempotent), R13, R16.

## Trigger

- An operation in `needs_attention` (after 5 failed attempts) on the admin `/operations` queue, or the admin "Today" page shows a dead-letter count above 0.
- The alarm "dead-letter queue not empty" on the `provisioning` FIFO queue (Section 3.3). The alarm definitions live in `infra/` when that track lands; until then the signals below are the log events.
- Log events: `operation_step`, `batch_failure`, `scheduler_job_failed`, `reconcile_stale_operations`.

## Who

Operations (`ops` role) in working hours; DevOps for a dead-letter message or a scheduler failure. Until day 14 the Track B driver.

## Safe checks (read only)

1. `/operations`: the operation's kind, step, attempts and last error class. Raw AWS errors and account ids are not shown to customers and not copied into tickets (R14, U6).
2. Is the resource already in AWS? Names are deterministic (`tc-<type>-<id>`), so a retry continues instead of duplicating (Section 10.1).
3. Dead-letter message: read its body in the console (operation id and `enqueue_seq` only). Never purge before you have noted the operation ids.
4. The `scheduler` re-sends `waiting` operations and `queued` ones unsent 2 minutes after `next_run_at`. A stuck `queued` operation is a scheduler problem: check `functions/scheduler` logs for `scheduler_job_failed`.

## Steps

1. Transient cause (quota, throttle, AWS outage): fix or wait, then `retryOperation` (back to `queued`).
2. Permanent cause (bad config, quota that cannot be raised, region full): `rejectOperation` with a reason. A create then becomes `failed` and the reversing ledger transaction (`order-reversal:<order id>`), capacity release and customer notice happen in one transaction. `failed` is final; retry is refused for it.
3. Dead-letter message with an operation that is `succeeded` or `failed` already: record it and delete the message after the operation ids are in the ticket. For an operation still open, retry it from `/operations`.
4. If many operations fail at once, check capacity ([capacity-full-and-quota.md](capacity-full-and-quota.md)) and then follow [incident.md](incident.md).

## Rollback

Do not undo AWS side effects by hand. A wrong `rejectOperation` is corrected by a new order and an adjustment (see [refund.md](refund.md)). Never delete a resource in a pool account from the console to "clean up".

## Log

Operation id, kind, step, decision, admin. The audit row is written by the action.

## Must not

Call Lightsail from the web or admin app (R1); assume a pool role from a laptop; change the queue or alarm settings in production by hand.
