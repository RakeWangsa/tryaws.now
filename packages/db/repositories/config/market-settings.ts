import { and, eq } from "drizzle-orm";
import type { Tx } from "../../client";
import { settings } from "../../schema/index";

// A whole-number setting of a market (scope 'market'), for caps and limits that the owner may tune
// without a deploy (WPU-B6). web_rw and worker_rw already have SELECT on these columns of `settings`.
// A missing row, a value that is not a whole number from 1 to 1,000,000, or a market that is not two
// capital letters is null, and the caller uses its own conservative default (R16): a bad row can
// never lift a cap.
const MARKET = /^[A-Z]{2}$/;
const WHOLE = /^[1-9][0-9]{0,6}$/;

export async function readMarketSettingNumber(
  tx: Tx,
  market: string,
  key: string,
): Promise<number | null> {
  if (!MARKET.test(market)) return null;
  const rows = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.market, market), eq(settings.scope, "market"), eq(settings.key, key)))
    .limit(1);
  const raw = rows[0]?.value;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!WHOLE.test(text)) return null;
  const n = +text;
  return n <= 1_000_000 ? n : null;
}
