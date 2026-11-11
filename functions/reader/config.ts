import { DEFAULT_RATE_LIMIT, type RateLimit } from "./handler";

export interface ReaderConfig {
  readonly rateLimit: RateLimit;
}

const MAX_RATE = 10_000;

// Fail closed (R16): the message names the variable and never its value (R3, R14). Only non-secret
// settings are read here.
export function readConfig(env: Record<string, string | undefined>): ReaderConfig {
  const raw = env.READER_RATE_MAX;
  if (raw === undefined) return { rateLimit: DEFAULT_RATE_LIMIT };
  if (!/^[0-9]{1,5}$/.test(raw)) throw new Error("reader: READER_RATE_MAX is missing or invalid");
  const max = +raw;
  if (max < 1 || max > MAX_RATE) throw new Error("reader: READER_RATE_MAX is missing or invalid");
  return { rateLimit: { max, windowMs: DEFAULT_RATE_LIMIT.windowMs } };
}
