import type { AdminActor, AdminRepos, AuditRow } from "@tc/db";
import { auditFilterOf, auditQueryOf } from "./audit-query.ts";
import { auditExportParams } from "./schemas.ts";

// The CSV export of the filtered /audit view (16.12). R9 in order: authenticate and authorize
// (superadmin; the repository checks again), validate (the same query parser as the page, plus the
// required `reason` of R10), rate limit, execute (the repository cuts the view at its hard cap and
// masks every row, R14), audit. The export is itself audited (R10): the repository appends one
// `audit.export` row with actor, IP, reason, the filter and the row count in the same transaction as
// the read; when that row cannot be written nothing is sent (R16). Every refusal has the same
// no-store headers and no body text.

export interface AuditExportDeps {
  readonly authorize: () => Promise<AdminActor>;
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  readonly run: <T>(actor: AdminActor, fn: (repos: AdminRepos) => Promise<T>) => Promise<T>;
  readonly clock: { now(): Date };
}

export type AuditExportAnswer =
  | { readonly status: 200; readonly body: string; readonly headers: Record<string, string> }
  | { readonly status: 400 | 403 | 429 | 503; readonly headers: Record<string, string> };

const NO_CACHE: Record<string, string> = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

// A cell that a spreadsheet would read as a formula starts with one of these (CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

const COLUMNS = [
  "id",
  "time",
  "actorType",
  "actorId",
  "action",
  "targetType",
  "targetId",
  "ip",
  "userAgent",
  "reason",
  "before",
  "after",
  "extra",
] as const;

const json = (value: unknown): string => (value === null ? "" : JSON.stringify(value));

export function rowsToCsv(rows: readonly AuditRow[]): string {
  const lines = [COLUMNS.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.createdAt.toISOString(),
        r.actorType,
        r.actorId,
        r.action,
        r.targetType,
        r.targetId,
        r.ip,
        r.userAgent,
        r.reason,
        json(r.before),
        json(r.after),
        json(r.extra),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export function makeAuditExport(
  deps: AuditExportDeps,
): (query: Record<string, string | string[] | undefined>) => Promise<AuditExportAnswer> {
  return async (query) => {
    let actor: AdminActor;
    try {
      actor = await deps.authorize();
    } catch {
      return { status: 403, headers: NO_CACHE };
    }
    try {
      const params = auditExportParams.safeParse({ reason: query?.reason });
      if (!params.success) return { status: 400, headers: NO_CACHE };
      const filter = auditFilterOf(auditQueryOf(query ?? {}));
      const at = deps.clock.now();
      if (!(await deps.limiter(actor, at))) return { status: 429, headers: NO_CACHE };
      // The repository reads the rows and appends the audit.export row in one transaction (R10). If
      // the row cannot be written the transaction fails, `run` throws and no file leaves (R16).
      const out = await deps.run(actor, (repos) => repos.audit.export(filter, params.data.reason));
      if (!out.ok) {
        const status = out.error === "forbidden" ? 403 : out.error === "validation" ? 400 : 503;
        return { status, headers: NO_CACHE };
      }
      return {
        status: 200,
        body: rowsToCsv(out.value.rows),
        headers: {
          ...NO_CACHE,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-${at.toISOString().slice(0, 10)}.csv"`,
          "X-Export-Truncated": out.value.truncated ? "true" : "false",
        },
      };
    } catch {
      return { status: 503, headers: NO_CACHE };
    }
  };
}
