import { UNPAID_SETTING_KEY } from "@tc/core";
import {
  AUDIT_PAGE_MAX,
  adminRepos,
  readMarketCodes,
  settingAuditFilter,
  type AdminActor,
  type AuditRow,
} from "@tc/db";
import type { Loaded } from "./ops-data.ts";
import { readTx } from "./pricing-runtime.ts";

// The read of /operations/unpaid-rule (WPU-Z4): for each market, the switch of the unpaid-usage job as the
// job reads it, and its last change from the audit log (who, when, why). R9 steps 1 and 2 were done by
// loadPageAdmin; every repository read checks the active admin and the role again. A refusal of the
// repository is the neutral page (`denied`); a failing database is a fixed state, never the text of an error
// (R14, R16). The loader takes the actor first.

export interface UnpaidRuleChange {
  /** The admin who changed it (the screen shows a short id, never an e-mail, R14). */
  readonly by: string | null;
  readonly at: Date;
  readonly reason: string | null;
  /** The value after the change. */
  readonly enabled: boolean;
}

export interface UnpaidRuleLine {
  readonly market: string;
  /** What the job reads: on only for a stored JSON true. */
  readonly enabled: boolean;
  readonly source: "none" | "stored" | "invalid";
  /** The newest audit row that changed the value (a replay changes nothing); null when there is none. */
  readonly lastChange: UnpaidRuleChange | null;
}

export interface UnpaidRuleScreen {
  readonly lines: readonly UnpaidRuleLine[];
}

const valueOf = (side: unknown): unknown =>
  typeof side === "object" && side !== null && "value" in side
    ? (side as { value: unknown }).value
    : undefined;

/** The newest row (rows come newest first) whose value before differs from the value after. */
export function lastChangeOf(rows: readonly AuditRow[]): UnpaidRuleChange | null {
  const row = rows.find((r) => valueOf(r.before) !== valueOf(r.after));
  if (row === undefined) return null;
  return {
    by: row.actorId,
    at: row.createdAt,
    reason: row.reason,
    enabled: valueOf(row.after) === true,
  };
}

type Read = { ok: true; lines: UnpaidRuleLine[] } | { ok: false; error: string };

export async function loadUnpaidRule(admin: AdminActor): Promise<Loaded<UnpaidRuleScreen>> {
  try {
    const read = await readTx(async (tx): Promise<Read> => {
      const repos = adminRepos(tx, admin);
      const lines: UnpaidRuleLine[] = [];
      for (const market of await readMarketCodes(tx)) {
        const stored = await repos.settings.read(UNPAID_SETTING_KEY, market);
        if (!stored.ok) return { ok: false, error: stored.error };
        const audit = await repos.audit.search({
          ...settingAuditFilter(market, UNPAID_SETTING_KEY),
          limit: AUDIT_PAGE_MAX,
        });
        if (!audit.ok) return { ok: false, error: audit.error };
        lines.push({
          market,
          enabled: stored.value.enabled,
          source: stored.value.source,
          lastChange: lastChangeOf(audit.value.rows),
        });
      }
      return { ok: true, lines };
    });
    if (read.ok) return { kind: "ok", value: { lines: read.lines } };
    return read.error === "forbidden" ? { kind: "denied" } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
