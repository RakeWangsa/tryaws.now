import { lifecycleRepo, type Tx } from "@tc/db";

// Section 11: every timing is a config value. The defaults are the values of the table; a row of
// `settings` (market BD, scope market) moves one of them without a code change.
export interface LifecycleConfig {
  readonly graceHours: number;
  readonly retentionDays: number;
  // Days before the period end; the email goes at each, the SMS only at smsReminderDay (16.14).
  readonly reminderDays: readonly number[];
  readonly smsReminderDay: number;
  readonly termDays: number;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = Object.freeze({
  graceHours: 48,
  retentionDays: 14,
  reminderDays: Object.freeze([7, 3, 1]) as readonly number[],
  smsReminderDay: 1,
  termDays: 30,
});

export const LIFECYCLE_SETTING_KEYS = Object.freeze({
  graceHours: "lifecycle_grace_hours",
  retentionDays: "lifecycle_retention_days",
  termDays: "lifecycle_term_days",
});

const MAX_VALUE = 100_000;

function whole(rows: ReadonlyMap<string, unknown>, field: keyof typeof LIFECYCLE_SETTING_KEYS) {
  const key = LIFECYCLE_SETTING_KEYS[field];
  if (!rows.has(key)) return DEFAULT_LIFECYCLE_CONFIG[field];
  const value = rows.get(key);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_VALUE) {
    throw new Error(`lifecycle config: ${field} is not valid`);
  }
  return value;
}

// Pure. A key that is present and wrong throws: a lifecycle that cannot read its timings does not
// run (R16). The message names the field and never the value (R14).
export function parseLifecycleConfig(rows: ReadonlyMap<string, unknown>): LifecycleConfig {
  return Object.freeze({
    ...DEFAULT_LIFECYCLE_CONFIG,
    graceHours: whole(rows, "graceHours"),
    retentionDays: whole(rows, "retentionDays"),
    termDays: whole(rows, "termDays"),
  });
}

export async function readLifecycleConfig(tx: Tx): Promise<LifecycleConfig> {
  const rows = await lifecycleRepo(tx).readSettings(Object.values(LIFECYCLE_SETTING_KEYS));
  return parseLifecycleConfig(rows);
}
