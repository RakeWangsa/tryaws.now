import {
  isOperationKind,
  OPERATION_STATES,
  QUOTA_CODES,
  type AdminActor,
  type AdminRepos,
  type CapacityRow,
  type OperationDetail,
  type OperationQueuePage,
  type OperationStateCounts,
  type OperationStateName,
  type PlanChangeView,
  type StuckRenewalRow,
  type WaitlistCount,
} from "@tc/db";
import { describeCorrection, parseLive, type Correction } from "./capacity-flow.ts";
import { readAsAdmin } from "./runtime.ts";

// The reads of /operations and /capacity (R9 steps 1 and 2 were done by loadPageAdmin; the repository
// checks the active admin and the role again and answers `forbidden`, which the page shows as the
// neutral page). A failing database gives a fixed state, never the text of an error (R14, R16).
export type Loaded<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

async function read<T>(
  admin: AdminActor,
  fn: (repos: AdminRepos) => Promise<Answer<T>>,
): Promise<Loaded<T>> {
  try {
    const out = await readAsAdmin(admin, fn);
    if (out.ok) return { kind: "ok", value: out.value };
    if (out.error === "forbidden") return { kind: "denied" };
    return out.error === "not_found" ? { kind: "missing" } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export interface OpsQuery {
  readonly state: OperationStateName | null;
  readonly kind: string | null;
  readonly after: string | null;
}

// The query of the page, from the URL: a value that is not one of ours is dropped.
export function opsQueryOf(raw: Record<string, string | string[] | undefined>): OpsQuery {
  const state = one(raw["state"]);
  const kind = one(raw["kind"]);
  const after = one(raw["after"]);
  return {
    state: (OPERATION_STATES as readonly string[]).includes(state)
      ? (state as OperationStateName)
      : null,
    kind: isOperationKind(kind) ? kind : null,
    after: UUID.test(after) ? after.toLowerCase() : null,
  };
}

export interface OpsQueues {
  readonly counts: OperationStateCounts;
  // With a state filter: the one list. Without: the two queues of 16.12 that need a person.
  readonly filtered: OperationQueuePage | null;
  readonly needsApproval: OperationQueuePage | null;
  readonly needsAttention: OperationQueuePage | null;
}

export async function loadOpsQueues(
  admin: AdminActor,
  query: OpsQuery,
): Promise<Loaded<OpsQueues>> {
  return read<OpsQueues>(admin, async (repos) => {
    const counts = await repos.operations.counts();
    if (!counts.ok) return counts;
    const page = (state?: OperationStateName, limit?: number) =>
      repos.operations.queue({
        ...(state === undefined ? {} : { state }),
        ...(query.kind === null ? {} : { kind: query.kind as never }),
        ...(query.after === null || limit !== undefined ? {} : { after: query.after }),
        ...(limit === undefined ? {} : { limit }),
      });
    if (query.state !== null) {
      const filtered = await page(query.state);
      if (!filtered.ok) return filtered;
      return {
        ok: true,
        value: {
          counts: counts.value,
          filtered: filtered.value,
          needsApproval: null,
          needsAttention: null,
        },
      };
    }
    const approval = await page("needs_approval", 50);
    if (!approval.ok) return approval;
    const attention = await page("needs_attention", 50);
    if (!attention.ok) return attention;
    return {
      ok: true,
      value: {
        counts: counts.value,
        filtered: null,
        needsApproval: approval.value,
        needsAttention: attention.value,
      },
    };
  });
}

export const loadOperation = (admin: AdminActor, id: string) =>
  read<OperationDetail>(admin, (repos) => repos.operations.detail(id));

// WPA-P2. The plan change of a container service or a CDN: the applied plan, the pending plan, the
// failure mark and the apply operations. The repository checks the role again.
export const loadResourcePlan = (admin: AdminActor, id: string) =>
  read<PlanChangeView>(admin, (repos) => repos.operations.planChange(id));

// ------------------------------------------------------------------------------------- capacity

export interface RecomputeQuery {
  readonly poolAccountId: string;
  readonly region: string;
  readonly quotaCode: string;
  readonly live: number | null;
}

// The preview asked by the URL: ?cell=<pool>~<region>~<quota>&live=<n>. Anything else drops it.
export function recomputeQueryOf(
  raw: Record<string, string | string[] | undefined>,
): RecomputeQuery | null {
  const parts = one(raw["cell"]).split("~");
  if (parts.length !== 3) return null;
  const [poolAccountId = "", region = "", quotaCode = ""] = parts;
  if (
    !UUID.test(poolAccountId) ||
    !/^(?:global|[a-z]{2}(?:-[a-z]+)+-[0-9])$/.test(region) ||
    !(QUOTA_CODES as readonly string[]).includes(quotaCode)
  ) {
    return null;
  }
  const liveText = one(raw["live"]);
  return {
    poolAccountId: poolAccountId.toLowerCase(),
    region,
    quotaCode,
    live: liveText === "" ? null : parseLive(liveText),
  };
}

export interface CapacityView {
  readonly rows: CapacityRow[];
  readonly waitlist: WaitlistCount[];
  readonly correction: Correction | null;
}

export const CAPACITY_MARKET = "BD";

export async function loadCapacity(
  admin: AdminActor,
  recompute: RecomputeQuery | null,
): Promise<Loaded<CapacityView>> {
  return read<CapacityView>(admin, async (repos) => {
    const rows = await repos.capacity.overview(CAPACITY_MARKET);
    if (!rows.ok) return rows;
    const waitlist = await repos.waitlist.counts();
    if (!waitlist.ok) return waitlist;
    let correction: Correction | null = null;
    if (recompute !== null && recompute.live !== null) {
      const cell = rows.value.find(
        (r) =>
          r.poolAccountId === recompute.poolAccountId &&
          r.region === recompute.region &&
          r.quotaCode === recompute.quotaCode,
      );
      // A cell that is not in the list has no correction to show.
      if (cell !== undefined) {
        const pending = await repos.capacity.pending({
          poolAccountId: recompute.poolAccountId,
          region: recompute.region,
          quotaCode: recompute.quotaCode as never,
        });
        if (!pending.ok) return pending;
        correction = describeCorrection(cell.used, recompute.live, pending.value);
      }
    }
    return { ok: true, value: { rows: rows.value, waitlist: waitlist.value, correction } };
  });
}

/**
 * WPU-X3 (b): the domain renewals stuck at the registry check, with the last "registry confirmed not renewed" check
 * of each (/payments/renewals). The repository answers `forbidden` for any role but finance and superadmin.
 */
export function loadStuckRenewals(admin: AdminActor): Promise<Loaded<StuckRenewalRow[]>> {
  return read(admin, (repos) => repos.operations.stuckRenewals());
}
