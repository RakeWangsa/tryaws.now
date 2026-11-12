// Steps 1 to 8 of the reservation (section 10.2), shared by the draft check and the purchase so
// that the two cannot drift apart. Not exported from the index.
import {
  capacityRepo,
  customerRepos,
  REGION_PATTERN,
  type CustomerHome,
  type CustomerRepos,
  type Tx,
} from "@tc/db";
import type { Result } from "../types";
import { allocate, resolveNeeds } from "./allocate";
import type { ReserveInput } from "./input";
import type { AllocationFailure, CapacityCell, Placement, PoolCandidate } from "./types";

export type Decision =
  | { kind: "answer"; result: Result<never> }
  | { kind: "no_room"; reason: AllocationFailure; repos: CustomerRepos }
  | { kind: "placed"; repos: CustomerRepos; home: CustomerHome | null; placement: Placement };

const FAMILY = /^[a-z][a-z0-9_]{0,39}$/;

// A full account may free up later; a request that cannot fit or an account that is not set up
// cannot be helped by waiting.
export function waitlistOffer(reason: AllocationFailure): "offered" | "not_offered" {
  return reason === "full" ? "offered" : "not_offered";
}

export async function decide(
  tx: Tx,
  input: ReserveInput,
  mode: "lock" | "read",
): Promise<Decision> {
  // 1. Throws a TypeError for a customer id that is not a UUID, before anything else (R16).
  const repos = customerRepos(tx, input.customerId);

  // 2. Validation. No query has been sent yet.
  const resolved = resolveNeeds(input.needs, input.region);
  if (!resolved.ok) {
    const field = REGION_PATTERN.test(input.region) ? "needs" : "region";
    return {
      kind: "answer",
      result: {
        ok: false,
        error: "validation",
        fields: {
          [field]: field === "region" ? "The Region is not valid." : "The needs are not valid.",
        },
      },
    };
  }
  if (
    input.waitlist !== undefined &&
    (!FAMILY.test(input.waitlist.productFamily) ||
      input.waitlist.idempotencyKey.length < 1 ||
      input.waitlist.idempotencyKey.length > 128)
  ) {
    return {
      kind: "answer",
      result: {
        ok: false,
        error: "validation",
        fields: { waitlist: "The waitlist request is not valid." },
      },
    };
  }

  // 3. The tier and the market come from the customer's own row.
  const profile = await repos.profile.get();
  if (profile === null) return { kind: "answer", result: { ok: false, error: "not_found" } };

  // 4. The home of the customer in this Region, if it has one.
  const home = await repos.homes.get(input.region);

  // 5. The cells of the needs: the home account only, or every active account of the tier.
  const cellKeys = resolved.needs.map((n) => ({ region: n.region, quotaCode: n.quotaCode }));
  const capacity = capacityRepo(tx);
  // The single-account rule (WPU-G1, runbook lightsail-parity-gap P1): when exactly ONE pool account
  // is active, it serves every risk tier, because a tier only separates accounts and there is
  // nothing to separate. With none, or two or more, the tier match is exact as before, and an
  // answer that cannot be given is a refusal (R16). It only widens the first choice of a customer
  // without a home; a home account is always kept.
  const sole = home === null ? await capacity.soleActiveAccount() : null;
  const selector =
    home !== null
      ? { accountId: home.poolAccountId, cells: cellKeys }
      : sole !== null
        ? { accountId: sole, cells: cellKeys }
        : { tiers: [profile.riskTier], cells: cellKeys };
  const rows =
    mode === "lock" ? await capacity.lockCells(selector) : await capacity.readCells(selector);

  // 6. The reserve per quota in the market of the customer.
  const reserves = await capacity.readReserves(profile.market);

  // 7. Candidates: active accounts only. A home account that is not active leaves no candidate.
  const byAccount = new Map<string, CapacityCell[]>();
  for (const row of rows) {
    if (row.status !== "active") continue;
    const cell: CapacityCell = {
      rowId: row.rowId,
      quotaCode: row.quotaCode,
      region: row.region,
      limit: row.limit,
      used: row.used,
      reserve: reserves.get(row.quotaCode) ?? 0,
    };
    const list = byAccount.get(row.poolAccountId);
    if (list === undefined) byAccount.set(row.poolAccountId, [cell]);
    else list.push(cell);
  }
  const candidates: PoolCandidate[] = [...byAccount].map(([poolAccountId, cells]) => ({
    poolAccountId,
    cells,
  }));

  // 8. The choice.
  const allocation = allocate(resolved.needs, candidates);
  if (!allocation.ok) return { kind: "no_room", reason: allocation.reason, repos };
  return { kind: "placed", repos, home, placement: allocation.placement };
}
