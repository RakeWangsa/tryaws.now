import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, it } from "vitest";

// R5, R7 and the wallet cache: the rows of wallets and of the three ledger tables are written by
// the functions of packages/db/ledger and by nothing else. Every other file goes through
// postTransaction, reverseTransaction, openWallet and ensureSystemAccounts of @tc/core.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TABLES = "wallets|ledger_accounts|ledger_transactions|ledger_entries";
const TABLE_OBJECTS = "wallets|ledgerAccounts|ledgerTransactions|ledgerEntries";
export const WRITES = [
  new RegExp(
    `\\b(?:insert\\s+into|update|delete\\s+from|truncate(?:\\s+table)?)\\s+(?:public\\.)?"?(?:${TABLES})"?(?![A-Za-z0-9_])`,
    "i",
  ),
  new RegExp(`\\.\\s*(?:insert|update|delete)\\s*\\(\\s*(?:${TABLE_OBJECTS})\\s*\\)`),
];
export const writesALedgerTable = (text) => WRITES.some((re) => re.test(text));

const ALLOWED = ["packages/db/ledger/", "packages/db/schema/", "packages/db/migrations/"];
const BUILD_FOLDERS = new Set(["node_modules", ".next", ".open-next", ".sst", "dist"]);
const PACKAGE_TEST_FOLDER = /^(?:apps|packages|functions)\/[^/]+\/test$/;
const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;
const TEST_FILE = /\.test\.(ts|tsx|mts|cts|mjs|cjs|js)$/;
const walk = (dir) =>
  readdirSync(posix.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = posix.join(dir, e.name);
    if (e.isDirectory()) {
      return BUILD_FOLDERS.has(e.name) || PACKAGE_TEST_FOLDER.test(p) ? [] : walk(p);
    }
    return e.isFile() ? [p] : [];
  });

it("the scan sees a statement that writes a ledger table, and nothing else", () => {
  for (const text of [
    "insert into wallets (id) values ($1)",
    'UPDATE "wallets" SET version = 1',
    "await tx.execute(sql`delete from ledger_entries`)",
    "insert into public.ledger_accounts (id) values ($1)",
    "truncate table ledger_transactions",
    "await tx.update(wallets).set({})",
    "db.insert( ledgerEntries ).values(rows)",
  ]) {
    expect(writesALedgerTable(text), text).toBe(true);
  }
  for (const text of [
    "select balance_minor from wallets where customer_id = $1",
    "constraint wallets_customer_id_unique",
    "update wallets_archive set x = 1",
    "insert into ledger_entries_backup values (1)",
    "the cache of wallets is changed by postTransaction",
    "tx.select().from(wallets)",
  ]) {
    expect(writesALedgerTable(text), text).toBe(false);
  }
});

it("no file outside packages/db/ledger writes wallets or a ledger table (tests and migrations excepted)", () => {
  const files = ["apps", "packages", "functions"]
    .flatMap(walk)
    .filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f))
    .filter((f) => !ALLOWED.some((a) => f.startsWith(a)));
  expect(files.length).toBeGreaterThanOrEqual(20);
  const offenders = files.filter((f) =>
    writesALedgerTable(readFileSync(posix.join(ROOT, f), "utf8")),
  );
  expect(offenders).toEqual([]);
});

it("the allowed folder exists and does write them (the scan is looking at the right place)", () => {
  const written = walk("packages/db/ledger").filter((f) =>
    writesALedgerTable(readFileSync(posix.join(ROOT, f), "utf8")),
  );
  expect(written.sort()).toEqual([
    "packages/db/ledger/accounts.ts",
    "packages/db/ledger/transactions.ts",
  ]);
});
