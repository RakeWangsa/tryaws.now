import { readFxRateInForce, readMarkets, type Tx } from "@tc/db";
import {
  FX_RATE_ALERT_AGE_DAYS,
  FX_RATE_MAX_AGE_DAYS,
  fxRateAgeSeconds,
  fxRateAlertDue,
  fxRateState,
  type FxRateState,
} from "../pricing/index";
import type { Logger, RunTx } from "../operations/types";
import type { Clock } from "../types";

// WPU-Y1. The rate is set by hand, so a forgotten rate is the failure to watch. When the rate of a market is older
// than 6 days (or missing) the scheduler writes ONE structured line with severity "alert" and event
// `fx_rate_stale_warning` once a day. The stage alarm matches that event (infra/stacks/alarms.ts) and the alarm tells
// finance by the existing alarm topic. The line holds the market code, a state word and whole days: no rate value,
// no admin, no secret (R14).
//
// Once a day without a store: the scheduler runs every minute, so the line is written only by the runs of the first
// five minutes after 10:00 in Dhaka (04:00 UTC, no daylight saving). One alarm state change a day follows; a run
// that falls outside that window writes nothing.

export const FX_ALERT_EVENT = "fx_rate_stale_warning";
const WINDOW_START_UTC_HOUR = 4;
const WINDOW_MINUTES = 5;
const DAY_S = 86_400;

/** True during the first five minutes after 10:00 in Dhaka. */
export function fxAlertWindowOpen(now: Date): boolean {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  return now.getUTCHours() === WINDOW_START_UTC_HOUR && now.getUTCMinutes() < WINDOW_MINUTES;
}

export interface FxWatchOps {
  markets(tx: Tx): Promise<string[]>;
  inForce(tx: Tx, market: string, at: Date): Promise<{ createdAt: Date } | null>;
}

export const defaultFxWatchOps: FxWatchOps = {
  markets: async (tx) => (await readMarkets(tx)).map((m) => m.code),
  inForce: (tx, market, at) => readFxRateInForce(tx, market, at),
};

export interface FxWatchDeps {
  readonly runTx: RunTx;
  readonly clock: Clock;
  readonly log: Logger;
  readonly ops?: FxWatchOps;
}

export interface FxWatchReport {
  readonly checked: number;
  readonly alerted: number;
  readonly states: Record<string, FxRateState>;
}

/** Reads the rate of every market and raises the daily alert. Read only; a failing logger never breaks the pass. */
export async function runFxRateWatch(deps: FxWatchDeps): Promise<FxWatchReport> {
  const ops = deps.ops ?? defaultFxWatchOps;
  const now = deps.clock.now();
  const states: Record<string, FxRateState> = {};
  let alerted = 0;
  const found = await deps.runTx(async (tx) => {
    const out: { market: string; enteredAt: Date | null }[] = [];
    for (const market of await ops.markets(tx)) {
      const rate = await ops.inForce(tx, market, now);
      out.push({ market, enteredAt: rate === null ? null : rate.createdAt });
    }
    return out;
  });
  for (const { market, enteredAt } of found) {
    const state = fxRateState(enteredAt, now);
    states[market] = state;
    if (!fxRateAlertDue(enteredAt, now) || !fxAlertWindowOpen(now)) continue;
    const seconds = fxRateAgeSeconds(enteredAt, now);
    try {
      deps.log({
        event: FX_ALERT_EVENT,
        severity: "alert",
        market,
        state,
        ageDays: seconds === null ? null : Math.floor(seconds / DAY_S),
        alertAfterDays: FX_RATE_ALERT_AGE_DAYS,
        maxAgeDays: FX_RATE_MAX_AGE_DAYS,
      });
    } catch {
      // swallowed on purpose: the pass only reads, and the screen shows the same state
    }
    alerted += 1;
  }
  return { checked: found.length, alerted, states };
}
