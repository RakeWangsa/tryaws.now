import { createDatabase, seedLaunchData, type LaunchSeedInput, type SeedResult } from "@tc/db";

/**
 * WPU-X6: seedLaunchData of @tc/db as the master user, which owns markets, fx_rates, pricing_rules,
 * feature_flags, settings and audit_log (no application role may write markets). One transaction: every row of
 * the seed commits or none does. Inserts only what is missing, so a second deploy writes nothing (R7).
 */
export async function seedLaunchAsOwner(url: string, input: LaunchSeedInput): Promise<SeedResult> {
  const { db, pool } = createDatabase(url, { max: 1 });
  pool.on("error", () => {});
  try {
    return await db.transaction((tx) => seedLaunchData(tx, input));
  } finally {
    await pool.end();
  }
}
