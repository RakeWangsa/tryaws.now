import type { CustomerSession } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";
import type {
  DatabaseSeriesView,
  MetricRangeKey,
  ReaderPort,
  TargetHealthWord,
  TargetReasonWord,
} from "./extras-view.ts";

// WPU-Y8. The two display reads of the reader (contract F, "Reader additions"): the health of the
// servers behind a load balancer and the metrics of a managed database. The web tier reaches them only
// through the reader port (R1). The ownership is checked here on the session's repositories and again
// by the reader (R8). Every failure is the "unavailable" state, never the text of it (U6, R14, R16).
// Read once on page load: no timer and no polling.

const LIVE: readonly string[] = ["active", "stopped", "suspended"];
const DB_LIVE: readonly string[] = ["active", "stopped"];

export interface TargetHealthRow {
  id: string;
  /** The name the customer gave the server (shown in the targets table too); "" when none. */
  name: string;
  health: TargetHealthWord;
  reason: TargetReasonWord | null;
}

export type TargetHealthScreen =
  | { state: "unavailable" }
  | { state: "not_live" }
  | { state: "empty"; checkedAt: string }
  | {
      state: "ready";
      checkedAt: string;
      rows: TargetHealthRow[];
      counts: Record<TargetHealthWord, number>;
      unresolved: number;
    };

export async function loadTargetHealth(
  session: CustomerSession,
  loadBalancerId: string,
  names: ReadonlyMap<string, string>,
  reader: ReaderPort | null,
): Promise<TargetHealthScreen> {
  if (reader === null) return { state: "unavailable" };
  try {
    const row = await withTx((tx) =>
      customerRepos(tx, session.customerId).resources.get(loadBalancerId),
    );
    if (row === null || row.family !== "load_balancer") return { state: "unavailable" };
    if (!LIVE.includes(row.state)) return { state: "not_live" };
    const result = await reader.targetHealth(loadBalancerId, { customerId: session.customerId });
    if (!result.ok) return { state: "unavailable" };
    const report = result.report;
    if (!report.live) return { state: "not_live" };
    if (report.targets.length === 0 && report.unresolved === 0) {
      return { state: "empty", checkedAt: report.checkedAt };
    }
    return {
      state: "ready",
      checkedAt: report.checkedAt,
      rows: report.targets.map((t) => ({
        id: t.targetResourceId,
        name: names.get(t.targetResourceId) ?? "",
        health: t.health,
        reason: t.reason,
      })),
      counts: { ...report.counts },
      unresolved: report.unresolved,
    };
  } catch {
    return { state: "unavailable" };
  }
}

export type DatabaseMetricsScreen =
  | { state: "unavailable" }
  | { state: "empty"; range: MetricRangeKey }
  | { state: "ready"; range: MetricRangeKey; series: DatabaseSeriesView[] };

export async function loadDatabaseMetrics(
  session: CustomerSession,
  databaseId: string,
  range: MetricRangeKey,
  reader: ReaderPort | null,
): Promise<DatabaseMetricsScreen> {
  if (reader === null) return { state: "unavailable" };
  try {
    const row = await withTx((tx) =>
      customerRepos(tx, session.customerId).resources.get(databaseId),
    );
    if (row === null || row.family !== "database") return { state: "unavailable" };
    if (!DB_LIVE.includes(row.state)) return { state: "empty", range };
    const result = await reader.databaseMetrics(
      databaseId,
      { customerId: session.customerId },
      range,
    );
    if (!result.ok) return { state: "unavailable" };
    const series = result.series.map((s) => ({ ...s }));
    return series.every((s) => s.points.length === 0)
      ? { state: "empty", range }
      : { state: "ready", range, series };
  } catch {
    return { state: "unavailable" };
  }
}
