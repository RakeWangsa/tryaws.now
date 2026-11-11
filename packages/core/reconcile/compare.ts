// The pure comparison of the reconciler (spec 3, 10): what one pool account holds in AWS against the
// `resources` rows of that account. It reports and never decides to delete or fix (R5, R13). A caller
// passes an account only when the read of AWS succeeded; an unreachable account is never turned into an
// empty list here (R16).

/** What the inventory port reports for one AWS resource, already mapped to platform words. */
export interface AwsItem {
  readonly region: string;
  readonly family: string;
  /** The generated name tc-<type>-<id> (R11). */
  readonly awsName: string;
  /** The port maps the AWS state to one of these; anything it cannot map is "unknown". */
  readonly state: "active" | "stopped" | "pending" | "unknown";
  /** True when the resource carries the platform tags (static IPs and automatic snapshots take none). */
  readonly tagged: boolean;
}

/** The columns of a `resources` row that the comparison needs. */
export interface DbRow {
  readonly id: string;
  readonly family: string;
  readonly region: string | null;
  readonly awsName: string | null;
  readonly state: string;
  readonly createdAt: Date;
}

export type FindingKind = "orphan" | "missing";
export type FindingReason =
  "no_row" | "row_destroyed" | "row_failed" | "no_aws_resource" | "state_drift";

export interface Finding {
  /** The value of `discrepancies.kind`. State drift is `missing` with reason `state_drift`. */
  readonly kind: FindingKind;
  readonly reason: FindingReason;
  readonly poolAccountId: string;
  readonly region: string | null;
  readonly family: string;
  readonly awsName: string;
  readonly resourceId?: string;
  readonly dbState?: string;
  readonly awsState?: string;
}

export interface CompareInput {
  readonly poolAccountId: string;
  readonly aws: readonly AwsItem[];
  readonly rows: readonly DbRow[];
  readonly now: Date;
  /** A row younger than this is not "missing" yet. Default one hour. */
  readonly graceMs?: number;
}

const DEFAULT_GRACE_MS = 3_600_000;
const LIVE_ROW_STATES: readonly string[] = ["active", "stopped", "suspended"];

// Which AWS states agree with a database state. Creating agrees with everything: the row exists
// before the create call, and the state of a resource that is being built is no drift.
function agrees(dbState: string, awsState: AwsItem["state"]): boolean {
  if (awsState === "pending" || awsState === "unknown" || dbState === "creating") return true;
  if (dbState === "active") return awsState === "active";
  if (dbState === "stopped" || dbState === "suspended") return awsState === "stopped";
  return true;
}

export function compareInventory(input: CompareInput): Finding[] {
  const { poolAccountId, now } = input;
  const grace = input.graceMs ?? DEFAULT_GRACE_MS;
  const byName = new Map<string, DbRow>();
  for (const row of input.rows) if (row.awsName !== null) byName.set(row.awsName, row);
  const awsNames = new Set<string>();
  const findings: Finding[] = [];

  for (const item of input.aws) {
    if (awsNames.has(item.awsName)) continue;
    awsNames.add(item.awsName);
    const row = byName.get(item.awsName);
    const base = {
      poolAccountId,
      region: item.region,
      family: item.family,
      awsName: item.awsName,
    };
    if (row === undefined) {
      if (item.tagged) findings.push({ kind: "orphan", reason: "no_row", ...base });
      continue;
    }
    if (row.state === "destroyed" || row.state === "failed") {
      findings.push({
        kind: "orphan",
        reason: row.state === "destroyed" ? "row_destroyed" : "row_failed",
        ...base,
        resourceId: row.id,
        dbState: row.state,
        awsState: item.state,
      });
    } else if (!agrees(row.state, item.state)) {
      findings.push({
        kind: "missing",
        reason: "state_drift",
        ...base,
        resourceId: row.id,
        dbState: row.state,
        awsState: item.state,
      });
    }
  }

  for (const row of input.rows) {
    if (row.awsName === null || row.region === null) continue;
    if (!LIVE_ROW_STATES.includes(row.state)) continue;
    if (now.getTime() - row.createdAt.getTime() < grace) continue;
    if (awsNames.has(row.awsName)) continue;
    findings.push({
      kind: "missing",
      reason: "no_aws_resource",
      poolAccountId,
      region: row.region,
      family: row.family,
      awsName: row.awsName,
      resourceId: row.id,
      dbState: row.state,
    });
  }

  return findings.sort(
    (a, b) => a.awsName.localeCompare(b.awsName) || a.reason.localeCompare(b.reason),
  );
}
