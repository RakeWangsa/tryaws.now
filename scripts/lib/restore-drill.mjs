// Pure helpers of scripts/restore-drill.mjs (WP9-T3 b). Nothing here starts a process or opens a
// connection. The drill is a LOGICAL restore on the LOCAL machine: it proves that a dump of the ledger
// restores into an empty database and that the restored copy still balances. The real point-in-time
// restore on RDS is a manual VERIFY step (docs/runbooks/restore-drill.md), never done by this script.
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import { isLocalDatabaseUrl, LOCAL_DATABASE_URL } from "./wallet-smoke.mjs";

export { isLocalDatabaseUrl, LOCAL_DATABASE_URL };

/** Exit codes: 0 passed, 1 failed or refused, 2 BLOCKED (a step could not run: never a pass). */
export const EXIT = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

/** The tables whose row counts must be the same in the source and in the restored copy. */
export const COUNTED_TABLES = Object.freeze([
  "customers",
  "wallets",
  "ledger_accounts",
  "ledger_transactions",
  "ledger_entries",
  "payments",
  "orders",
  "resources",
  "subscriptions",
  "operations",
  "audit_log",
]);

const WALLET_NET = `select w.id, w.balance_minor as cached, coalesce(s.net, 0) as entries
    from wallets w
    left join ledger_accounts a on a.customer_id = w.customer_id and a.type = 'customer_wallet' and a.currency = w.currency
    left join lateral (select sum(case e.direction when 'credit' then e.amount_minor else -e.amount_minor end) as net
                         from ledger_entries e where e.account_id = a.id) s on true`;

/**
 * The ledger check and the wallet = ledger invariant (the same findings as packages/core checkLedger),
 * one number each; every one must be 0 on the restored copy. Read-only SELECTs, no parameters.
 */
export const INVARIANTS = Object.freeze([
  {
    id: "wallet_equals_ledger",
    title: "the cached balance of every wallet is the sum of its ledger entries",
    sql: `select count(*) from (${WALLET_NET}) x where x.cached <> x.entries`,
  },
  {
    id: "no_negative_wallet",
    title: "no wallet is below zero",
    sql: `select count(*) from (${WALLET_NET}) x where x.cached < 0 or x.entries < 0`,
  },
  {
    id: "transactions_balance",
    title: "every ledger transaction balances (debits = credits) in each currency",
    sql: `select count(*) from (select 1 from ledger_entries e join ledger_accounts a on a.id = e.account_id
            group by e.transaction_id, a.currency
           having sum(case e.direction when 'debit' then e.amount_minor else -e.amount_minor end) <> 0) x`,
  },
  {
    id: "no_one_sided_transaction",
    title: "every ledger transaction has a debit and a credit",
    sql: `select count(*) from ledger_transactions t
           where not exists (select 1 from ledger_entries e where e.transaction_id = t.id and e.direction = 'debit')
              or not exists (select 1 from ledger_entries e where e.transaction_id = t.id and e.direction = 'credit')`,
  },
  {
    id: "no_wallet_account_without_wallet",
    title: "no customer wallet account with entries lacks a wallet",
    sql: `select count(*) from (select a.id from ledger_accounts a join ledger_entries e on e.account_id = a.id
           where a.type = 'customer_wallet'
             and not exists (select 1 from wallets w where w.customer_id = a.customer_id and w.currency = a.currency)
           group by a.id) x`,
  },
]);

/**
 * The guard (R3, R16). Returns { ok: true, url, env } or { ok: false, reason }; the reason never
 * holds the URL. Refused: stage staging or production, any database that is not on this machine, and a
 * name of a database that the drill itself would have to create or drop outside its own prefix.
 */
export function drillGuard(env) {
  const stage = env.TC_STAGE;
  if (stage === "staging" || stage === "production") {
    return { ok: false, reason: "TC_STAGE is staging or production: the drill runs locally only" };
  }
  for (const name of ["SST_STAGE", "STAGE"]) {
    if (env[name] === "staging" || env[name] === "production") {
      return { ok: false, reason: `${name} is staging or production: the drill runs locally only` };
    }
  }
  const url =
    env.DATABASE_URL === undefined || env.DATABASE_URL === ""
      ? LOCAL_DATABASE_URL
      : env.DATABASE_URL;
  if (!isLocalDatabaseUrl(url)) {
    return {
      ok: false,
      reason: "DATABASE_URL is not a local address: the drill runs locally only",
    };
  }
  return { ok: true, url };
}

/** The prefix of every database this drill creates. Nothing else is ever dropped. */
export const TEMP_PREFIX = "tc_restore_drill_";

export function tempDatabaseName() {
  return `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`;
}

/** The same server and credentials, another database name. Throws on a URL that is not local. */
export function urlWithDatabase(url, database) {
  if (!isLocalDatabaseUrl(url)) throw new Error("restore-drill: the URL is not local");
  if (!/^[a-z0-9_]{1,63}$/.test(database)) throw new Error("restore-drill: bad database name");
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** True only for the name of a database this drill made (so a drop can never reach another one). */
export function isDrillDatabase(name) {
  return typeof name === "string" && new RegExp(`^${TEMP_PREFIX}[0-9a-f]{12}$`).test(name);
}

export function blocked(reason) {
  return { exit: EXIT.blocked, line: `BLOCKED: ${reason}` };
}

/**
 * Decides the outcome from what the drill measured. `source` and `restored` are
 * { counts: {table: number}, invariants: {id: number} } read from the two databases.
 * A copy that differs from the source, or that breaks an invariant, fails. An empty ledger passes only
 * with allowEmpty, and says so: it proved the mechanics, not the data.
 */
export function evaluate({ source, restored, allowEmpty }) {
  const problems = [];
  for (const table of COUNTED_TABLES) {
    if (source.counts[table] !== restored.counts[table]) {
      problems.push(
        `${table}: ${source.counts[table]} rows in the source, ${restored.counts[table]} restored`,
      );
    }
  }
  for (const check of INVARIANTS) {
    const found = restored.invariants[check.id];
    if (found !== 0)
      problems.push(`${check.id}: ${found} finding(s) on the restored copy (${check.title})`);
  }
  if (problems.length > 0) return { exit: EXIT.failed, lines: problems.map((p) => `FAIL ${p}`) };
  const entries = restored.counts["ledger_entries"];
  if (entries === 0 && !allowEmpty) {
    return blocked(
      "the source ledger is empty, so the drill would prove nothing about data (use --allow-empty for the mechanics only)",
    );
  }
  const note = entries === 0 ? " (mechanics only: the ledger of the source is empty)" : "";
  return {
    exit: EXIT.passed,
    lines: [
      `PASS restored copy equals the source in ${COUNTED_TABLES.length} tables and holds ${INVARIANTS.length} invariants${note}`,
    ],
  };
}

/** One number from the output of `psql -At` (a single value). Throws on anything else. */
export function oneNumber(output) {
  const text = String(output).trim();
  if (!/^[0-9]+$/.test(text)) throw new Error("restore-drill: a count was expected");
  return Number(text);
}
