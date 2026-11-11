import {
  capacityInventoryRepo,
  capacityRepo,
  isCellKey,
  ROLLING_WINDOW_CODES,
  type QuotaCode,
  type Tx,
} from "@tc/db";
import type { Clock } from "../types";

const DAY_MS = 86_400_000;
const ROLLING_WINDOW_DAYS = 365;

// 10.2: the hourly inventory run never sets used below the live count plus the reservations of
// creates that have not succeeded.
export function correctedUsed(live: number, pending: number): number {
  if (!Number.isInteger(live) || live < 0 || !Number.isInteger(pending) || pending < 0) {
    throw new RangeError("capacity: live and pending are whole numbers of units");
  }
  return live + pending;
}

export interface InventoryInput {
  poolAccountId: string;
  region: string;
  quotaCode: QuotaCode;
  // The live count from AWS; ignored for certificate_365d (pass 0), which is counted from the
  // platform's own records.
  live: number;
  clock: Clock;
}

export interface InventoryOutcome {
  used: number;
  previous: number;
  pending: number;
}

export async function recomputeUsed(tx: Tx, input: InventoryInput): Promise<InventoryOutcome> {
  const { poolAccountId, region, quotaCode, clock } = input;
  if (!isCellKey(quotaCode, region)) throw new TypeError("capacity: the cell is not valid");
  // The cell is locked first: a purchase that reserves it either committed before (its resource is
  // visible to pendingFor) or waits until this transaction ends.
  const [row] = await capacityRepo(tx).lockCells({
    accountId: poolAccountId,
    cells: [{ region, quotaCode }],
  });
  if (!row) throw new Error("capacity: the row to correct does not exist");
  const inventory = capacityInventoryRepo(tx);
  const pending = await inventory.pendingFor(poolAccountId, { region, quotaCode });
  const live = ROLLING_WINDOW_CODES.includes(quotaCode)
    ? await inventory.certificatesSince(
        poolAccountId,
        region,
        new Date(clock.now().getTime() - ROLLING_WINDOW_DAYS * DAY_MS),
      )
    : input.live;
  const used = correctedUsed(live, pending);
  await inventory.setInventory(row.rowId, row.used, used, clock.now());
  return { used, previous: row.used, pending };
}
