import { epsReturnUrls } from "@tc/eps";
import { DEFAULT_SWEEP_LIMIT, MAX_SWEEP_LIMIT } from "./handler";

export interface SweeperConfig {
  readonly mode: "production" | "sandbox";
  readonly baseUrl: string;
  readonly limit: number;
}

// Fail closed (R16): the message names the variable and never its value (R3, R14).
// Only non-secret settings are read here; the EPS secrets come through the SecretSource port.
// TC_ENV is not read.
export function readConfig(env: Record<string, string | undefined>): SweeperConfig {
  const bad = (name: string): Error => new Error(`sweeper: ${name} is missing or invalid`);

  const mode = env.EPS_MODE;
  if (mode !== "production" && mode !== "sandbox") throw bad("EPS_MODE");

  const baseUrl = env.PUBLIC_BASE_URL;
  if (typeof baseUrl !== "string") throw bad("PUBLIC_BASE_URL");
  try {
    epsReturnUrls(baseUrl);
  } catch {
    throw bad("PUBLIC_BASE_URL");
  }

  let limit = DEFAULT_SWEEP_LIMIT;
  const rawLimit = env.SWEEP_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^[0-9]{1,3}$/.test(rawLimit)) throw bad("SWEEP_LIMIT");
    limit = +rawLimit;
    if (limit < 1 || limit > MAX_SWEEP_LIMIT) throw bad("SWEEP_LIMIT");
  }
  return { mode, baseUrl, limit };
}
