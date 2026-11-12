// node scripts/restore-drill.mjs [--allow-empty]
// WP9-T3 (b): the restore drill of the LOCAL database. It takes a logical dump with pg_dump, restores
// it into a temporary database next to the source, runs the ledger check and the wallet = ledger
// invariant on the restored copy, compares the row counts with the source and drops the copy.
//   exit 0  the copy equals the source and holds every invariant
//   exit 1  refused (staging or production, a database that is not local) or a check failed
//   exit 2  BLOCKED: pg_dump (or the database) is not there, or the source ledger is empty without
//           --allow-empty. A skipped drill is never a pass (R16).
// It never reaches a database that is not on this machine (R3) and never touches AWS. The point-in-time
// restore on RDS is a manual VERIFY step: docs/runbooks/restore-drill.md.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrill } from "./lib/restore-drill-run.mjs";

const exec = (tool, args, env) => {
  const out = spawnSync(tool, args, {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: out.status, stdout: out.stdout ?? "" };
};

const tempDir = () => {
  const path = mkdtempSync(join(tmpdir(), "tc-restore-drill-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
};

const result = runDrill({ env: process.env, argv: process.argv.slice(2), exec, tempDir });
for (const line of result.lines) process.stdout.write(`${line}\n`);
process.exit(result.exit);
