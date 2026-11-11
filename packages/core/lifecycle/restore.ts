import { lifecycleRepo, type Tx } from "@tc/db";
import type { Clock, Result } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

// The last step of a restore during retention (section 11): the subscription is `active` again and
// the new period starts at the restore time. The restore flow (WP5-T1, WP5-T2) comes first in the
// same transaction: it has charged the wallet, reserved the capacity and made the resource `active`
// again. This function only checks that and moves the subscription, so it is the one place that
// leaves `retained`. It refuses (R16) when the subscription is not retained, when the resource is
// still destroyed, and on a second call (`conflict`: the first call changed the state).
export async function completeRestore(
  tx: Tx,
  input: { subscriptionId: string; clock: Clock },
): Promise<Result<{ periodEnd: Date }>> {
  const repo = lifecycleRepo(tx);
  const row = await repo.lock(input.subscriptionId);
  if (row === null) return { ok: false, error: "not_found" };
  if (row.status !== "retained") return { ok: false, error: "conflict" };
  if (row.resource.state === "destroyed" || row.resource.state === "failed") {
    return { ok: false, error: "conflict", fields: { resource: "not_restored" } };
  }
  const now = input.clock.now();
  if (Number.isNaN(now.getTime())) return { ok: false, error: "internal" };
  const periodEnd = new Date(now.getTime() + row.termDays * DAY_MS);
  await repo.setPeriod(row.id, { status: "active", periodStart: now, periodEnd });
  return { ok: true, value: { periodEnd } };
}
