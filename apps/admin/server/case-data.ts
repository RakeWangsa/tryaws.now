import type {
  AbuseCaseDetail,
  AbuseListResult,
  CaseStatus,
  DiscrepancyKind,
  DiscrepancyState,
  ReconciliationListResult,
  ReconciliationOverview,
  SupportListResult,
  SupportRequestDetail,
  SupportStatus,
} from "@tc/db";
import type { AdminActor } from "@tc/db";
import { read, type Loaded } from "./customers-data.ts";

// The reads of /support, /abuse and /reconciliation (R9 steps 1 and 2 were done by loadPageAdmin; the
// repository checks the role again). A refusal or a failing database gives a fixed state, never the
// text of an error (R14, R16).
export type { Loaded };

export interface CaseQuery {
  readonly status: CaseStatus | null;
  readonly after: string | null;
}

// WPU-Z5: a support request is open, answered or closed.
export interface SupportQuery {
  readonly status: SupportStatus | null;
  readonly after: string | null;
}

export interface ReconciliationQuery {
  readonly kind: DiscrepancyKind | null;
  readonly status: DiscrepancyState | null;
  readonly after: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_STATUS = ["open", "closed"] as const;
const SUPPORT_STATUS = ["open", "answered", "closed"] as const;
const KINDS = ["orphan", "missing", "cost", "payment"] as const;
const STATES = ["open", "resolved"] as const;

type Raw = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

// The query of the page, from the URL: a value that is not one of ours is dropped, never passed on.
// The default of a queue is its open rows.
export function caseQueryOf(raw: Raw): CaseQuery {
  const status = one(raw["status"]);
  const after = one(raw["after"]);
  return {
    status:
      status === "all"
        ? null
        : (CASE_STATUS as readonly string[]).includes(status)
          ? (status as CaseStatus)
          : "open",
    after: UUID.test(after) ? after : null,
  };
}

// The support queue: the same rules with the three states of a request. The default is the open rows,
// the requests that wait for support.
export function supportQueryOf(raw: Raw): SupportQuery {
  const status = one(raw["status"]);
  const after = one(raw["after"]);
  return {
    status:
      status === "all"
        ? null
        : (SUPPORT_STATUS as readonly string[]).includes(status)
          ? (status as SupportStatus)
          : "open",
    after: UUID.test(after) ? after : null,
  };
}

export function reconciliationQueryOf(raw: Raw): ReconciliationQuery {
  const kind = one(raw["kind"]);
  const status = one(raw["status"]);
  const after = one(raw["after"]);
  return {
    kind: (KINDS as readonly string[]).includes(kind) ? (kind as DiscrepancyKind) : null,
    status:
      status === "all"
        ? null
        : (STATES as readonly string[]).includes(status)
          ? (status as DiscrepancyState)
          : "open",
    after: UUID.test(after) ? after : null,
  };
}

export const loadSupportList = (admin: AdminActor, query: SupportQuery) =>
  read<SupportListResult>(admin, (repos) =>
    repos.support.list({
      ...(query.status === null ? {} : { status: query.status }),
      ...(query.after === null ? {} : { after: query.after }),
    }),
  );

export const loadSupportDetail = (admin: AdminActor, id: string) =>
  read<SupportRequestDetail>(admin, (repos) => repos.support.detail(id));

export const loadAbuseList = (admin: AdminActor, query: CaseQuery) =>
  read<AbuseListResult>(admin, (repos) =>
    repos.abuse.list({
      ...(query.status === null ? {} : { status: query.status }),
      ...(query.after === null ? {} : { after: query.after }),
    }),
  );

export const loadAbuseDetail = (admin: AdminActor, id: string) =>
  read<AbuseCaseDetail>(admin, (repos) => repos.abuse.detail(id));

export const loadReconciliation = (admin: AdminActor, query: ReconciliationQuery) =>
  read<{ overview: ReconciliationOverview; list: ReconciliationListResult }>(
    admin,
    async (repos) => {
      const overview = await repos.reconciliation.overview();
      if (!overview.ok) return overview;
      const list = await repos.reconciliation.list({
        ...(query.kind === null ? {} : { kind: query.kind }),
        ...(query.status === null ? {} : { status: query.status }),
        ...(query.after === null ? {} : { after: query.after }),
      });
      if (!list.ok) return list;
      return { ok: true as const, value: { overview: overview.value, list: list.value } };
    },
  );
