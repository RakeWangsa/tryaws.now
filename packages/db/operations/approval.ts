import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../client";
import { settings } from "../schema/catalog";

// The end date of the R13 approval period is a setting, so it can move without a code change.
export const APPROVAL_SETTING = {
  key: "r13_approval_until",
  market: "BD",
  scope: "market",
} as const;

// Names only columns that web_rw and worker_rw may SELECT. A missing row, a value that is not a
// string and an unparsable string give null, so approval is required (R16). A database error is not
// caught: the caller's transaction fails.
export async function readApprovalUntil(tx: Tx): Promise<Date | null> {
  const rows = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, APPROVAL_SETTING.key),
        eq(settings.market, APPROVAL_SETTING.market),
        eq(settings.scope, APPROVAL_SETTING.scope),
        isNull(settings.scopeId),
      ),
    )
    .limit(1);
  const value = rows[0]?.value;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
