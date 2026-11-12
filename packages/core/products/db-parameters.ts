import type { Result } from "../types";

// The parameters of a database that a customer may change (WPU-G11). Lightsail lists several hundred
// parameters of a parameter group; most of them can break the database or the platform. Only the safe
// ones below are shown and changed, per engine. A name comes from this list and nowhere else, a value
// is checked against the rule of its parameter, and the result is a plain text of a few characters
// (R11, R16). Pure: no AWS, no HTTP.

export type DbEngine = "mysql" | "postgres";

export type DbParameterRule =
  | { readonly name: string; readonly kind: "int"; readonly min: number; readonly max: number }
  | { readonly name: string; readonly kind: "bool" }
  | { readonly name: string; readonly kind: "enum"; readonly values: readonly string[] };

const int = (name: string, min: number, max: number): DbParameterRule => ({
  name,
  kind: "int",
  min,
  max,
});
const bool = (name: string): DbParameterRule => ({ name, kind: "bool" });
const choice = (name: string, ...values: string[]): DbParameterRule => ({
  name,
  kind: "enum",
  values,
});

/** The whitelist. Booleans are "0" and "1" (what the Lightsail parameter groups report). VERIFY. */
export const DB_PARAMETER_RULES: Readonly<Record<DbEngine, readonly DbParameterRule[]>> = {
  mysql: [
    int("max_connections", 1, 16000),
    int("wait_timeout", 1, 31536000),
    int("interactive_timeout", 1, 31536000),
    int("max_allowed_packet", 1024, 1073741824),
    int("innodb_lock_wait_timeout", 1, 3600),
    int("long_query_time", 0, 3600),
    bool("slow_query_log"),
    bool("general_log"),
    choice("character_set_server", "utf8mb4", "utf8", "latin1"),
  ],
  postgres: [
    int("max_connections", 5, 16000),
    int("statement_timeout", 0, 2147483647),
    int("lock_timeout", 0, 2147483647),
    int("idle_in_transaction_session_timeout", 0, 2147483647),
    int("log_min_duration_statement", -1, 2147483647),
    int("work_mem", 64, 2097151),
    choice("log_statement", "none", "ddl", "mod", "all"),
    bool("log_connections"),
    bool("log_disconnections"),
  ],
};

export const MAX_DB_PARAMETER_CHANGES = 10;

const ENGINES: Readonly<Record<string, DbEngine>> = { mysql: "mysql", postgres: "postgres" };

/** The engine word of Lightsail, lower case, or null for anything else (R16). */
export function dbEngineFrom(value: unknown): DbEngine | null {
  return typeof value === "string" ? (ENGINES[value.trim().toLowerCase()] ?? null) : null;
}

const INT_TEXT = /^-?[0-9]{1,10}$/;

/** The canonical text of a value by the rule, or null. No float, no sign other than -1, no unit. */
function valueOf(rule: DbParameterRule, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (rule.kind === "bool") return text === "0" || text === "1" ? text : null;
  if (rule.kind === "enum") return rule.values.includes(text) ? text : null;
  if (!INT_TEXT.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= rule.min && n <= rule.max ? String(n) : null;
}

function ruleOf(engine: DbEngine, name: string): DbParameterRule | undefined {
  return DB_PARAMETER_RULES[engine].find((r) => r.name === name);
}

export interface DbParameterChange {
  readonly name: string;
  readonly value: string;
}

/**
 * The checked change set. `input` maps a parameter name to its new value text. Every name must be on
 * the list of the engine and every value must pass its rule; one bad entry refuses the whole set, and
 * the failing names come back as `fields` (a value is never echoed).
 */
export function checkedDbParameterChanges(
  engine: unknown,
  input: unknown,
): Result<readonly DbParameterChange[]> {
  const known = dbEngineFrom(engine);
  if (known === null) return { ok: false, error: "validation", fields: { engine: "invalid" } };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "validation", fields: { parameters: "invalid" } };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_DB_PARAMETER_CHANGES) {
    return { ok: false, error: "validation", fields: { parameters: "invalid" } };
  }
  const fields: Record<string, string> = {};
  const value: DbParameterChange[] = [];
  for (const [name, raw] of entries) {
    const rule = ruleOf(known, name);
    const checked = rule === undefined ? null : valueOf(rule, raw);
    if (rule === undefined || checked === null) {
      // The key is customer text: only a name of the list may be used as a field key.
      fields[rule === undefined ? "parameters" : name] = "invalid";
    } else value.push({ name, value: checked });
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  // Keep the order of the list, so two equal requests give one payload (R7).
  const order = DB_PARAMETER_RULES[known].map((r) => r.name);
  value.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return { ok: true, value };
}

export interface LiveDbParameter {
  readonly name?: unknown;
  readonly value?: unknown;
  readonly applyType?: unknown;
  readonly modifiable?: unknown;
}

export type DbParameterApply = "immediate" | "pending-reboot" | "unknown";

export interface DbParameterFact {
  readonly name: string;
  /** The current value as text, or null if it is missing or does not pass the rule of the parameter. */
  readonly value: string | null;
  /** When a change takes effect: a dynamic parameter at once, a static one at the next reboot. */
  readonly apply: DbParameterApply;
  readonly changeable: boolean;
}

/**
 * The parameters to show and keep: only those of the whitelist, in the order of the list, with a value
 * that passes its rule (else null) and an apply word from a closed set. Anything else Lightsail sent
 * (descriptions, allowed values, other names) is dropped (R14, R16).
 */
export function safeDbParameterList(
  engine: unknown,
  live: readonly LiveDbParameter[],
): DbParameterFact[] {
  const known = dbEngineFrom(engine);
  if (known === null) return [];
  const out: DbParameterFact[] = [];
  for (const rule of DB_PARAMETER_RULES[known]) {
    const found = live.find((p) => p.name === rule.name);
    if (found === undefined) continue;
    const apply: DbParameterApply =
      found.applyType === "dynamic"
        ? "immediate"
        : found.applyType === "static"
          ? "pending-reboot"
          : "unknown";
    out.push({
      name: rule.name,
      value: valueOf(rule, found.value),
      apply,
      changeable: found.modifiable === true && apply !== "unknown",
    });
  }
  return out;
}
