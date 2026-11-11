import { asc, eq } from "drizzle-orm";
import type { Tx } from "../../client";
import type { MARKET_NUMERALS } from "../../schema/index";
import { markets } from "../../schema/index";
import { isMarketCode } from "./args";

export interface MarketBasics {
  code: string;
  currency: string;
  locales: string[];
  numerals: (typeof MARKET_NUMERALS)[number];
}

export interface Market extends MarketBasics {
  gateway: string;
  topupMinMinor: bigint;
  topupMaxMinor: bigint;
  quickAmounts: number[];
  active: boolean;
}

// The four columns that worker_rw may read; the database, not a rule of ours, refuses the rest.
const basics = {
  code: markets.code,
  currency: markets.currency,
  locales: markets.locales,
  numerals: markets.numerals,
};

const whole = {
  ...basics,
  gateway: markets.gateway,
  topupMinMinor: markets.topupMinMinor,
  topupMaxMinor: markets.topupMaxMinor,
  quickAmounts: markets.quickAmounts,
  active: markets.active,
};

export async function readMarket(tx: Tx, code: string): Promise<Market | null> {
  if (!isMarketCode(code)) return null;
  const rows = await tx.select(whole).from(markets).where(eq(markets.code, code)).limit(1);
  return (rows[0] as Market | undefined) ?? null;
}

export async function readMarkets(tx: Tx): Promise<Market[]> {
  return (await tx.select(whole).from(markets).orderBy(asc(markets.code))) as Market[];
}

export async function readMarketBasics(tx: Tx, code: string): Promise<MarketBasics | null> {
  if (!isMarketCode(code)) return null;
  const rows = await tx.select(basics).from(markets).where(eq(markets.code, code)).limit(1);
  return (rows[0] as MarketBasics | undefined) ?? null;
}
