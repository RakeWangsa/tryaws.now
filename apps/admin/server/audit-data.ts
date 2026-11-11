import type { AdminActor, AdminRepos, AuditRow, AuditSearchResult } from "@tc/db";
import { auditFilterOf, type AuditQuery } from "./audit-query.ts";
import type { Loaded } from "./money-data.ts";
import { readAsAdmin } from "./runtime.ts";

// The reads of the audit screens (R9 steps 1 and 2 were done by loadPageAdmin; the repository checks
// the role and the active admin again). A refusal or a failing database gives a fixed state, never the
// text of an error (R14, R16). The rows are masked by the repository.
type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

async function read<T>(
  admin: AdminActor,
  fn: (repos: AdminRepos) => Promise<Answer<T>>,
): Promise<Loaded<T>> {
  try {
    const out = await readAsAdmin(admin, fn);
    if (out.ok) return { kind: "ok", value: out.value };
    return out.error === "not_found" ? { kind: "missing" } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export const loadAudit = (
  admin: AdminActor,
  query: AuditQuery,
): Promise<Loaded<AuditSearchResult>> =>
  read<AuditSearchResult>(admin, (repos) =>
    repos.audit.search({
      ...auditFilterOf(query),
      ...(query.after === null ? {} : { after: query.after }),
    }),
  );

export const loadAuditRow = (admin: AdminActor, id: string): Promise<Loaded<AuditRow>> =>
  read<AuditRow>(admin, (repos) => repos.audit.detail(id));
