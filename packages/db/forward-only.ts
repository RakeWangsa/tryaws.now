// R15: migrations are forward-only. A pure comparison of two migration trees, plus readers for
// the working tree and for a git ref. Paths are relative to packages/db/migrations, with "/".
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type MigrationTree = ReadonlyMap<string, string>;

const JOURNAL = "meta/_journal.json";
const MIGRATIONS_PATH = "packages/db/migrations";

type JournalEntry = { when: number; tag: string };

function journalEntries(tree: MigrationTree): unknown[] {
  let parsed: { entries?: unknown[] };
  try {
    parsed = JSON.parse(tree.get(JOURNAL) ?? "{}") as { entries?: unknown[] };
  } catch {
    throw new Error(`forward-only check: ${JOURNAL} is not valid JSON`);
  }
  return parsed.entries ?? [];
}

// Rules, in the order of their messages: 1 committed files are not deleted or changed; 2 committed
// journal entries are not changed or removed; 3 the journal is strictly increasing in `when` and
// every entry has its .sql file; 4 without a journal (folder layout) new migrations sort last;
// 5 every .sql file in the folder is named by the journal (drizzle runs only what it names).
export function checkForwardOnly(base: MigrationTree, current: MigrationTree): string[] {
  const problems: string[] = [];
  const baseEntries = journalEntries(base);
  const currentEntries = journalEntries(current);

  // Rule 1: committed files are neither deleted nor changed.
  for (const [path, text] of base) {
    if (path === JOURNAL) continue;
    const now = current.get(path);
    if (now === undefined) problems.push(`${path} was deleted`);
    else if (now !== text) problems.push(`${path} was changed`);
  }

  // Rule 2: the committed journal entries stay as they are.
  if (base.has(JOURNAL)) {
    if (!current.has(JOURNAL)) problems.push(`${JOURNAL} was deleted`);
    else {
      baseEntries.forEach((entry, i) => {
        if (i >= currentEntries.length) problems.push(`${JOURNAL} entry ${i} was removed`);
        else if (!isDeepStrictEqual(entry, currentEntries[i]))
          problems.push(`${JOURNAL} entry ${i} was changed`);
      });
    }
  }

  // Rule 3: order and files of the current journal (drizzle skips an older `when` in silence).
  if (current.has(JOURNAL)) {
    const entries = currentEntries as JournalEntry[];
    entries.forEach((entry, i) => {
      if (i > 0 && !(entry.when > entries[i - 1]!.when))
        problems.push(`${JOURNAL} entry ${i} is not newer than entry ${i - 1}`);
      if (!current.has(`${entry.tag}.sql`))
        problems.push(`${JOURNAL} entry ${i} has no ${entry.tag}.sql`);
    });
  }

  // Rule 4: folder layout (no journal anywhere): a new migration sorts after every old one.
  if (!base.has(JOURNAL) && !current.has(JOURNAL)) {
    const top = (tree: MigrationTree) => new Set([...tree.keys()].map((p) => p.split("/")[0]!));
    const old = top(base);
    const last = [...old].sort().at(-1);
    for (const name of [...top(current)].sort()) {
      if (!old.has(name) && last !== undefined && name < last)
        problems.push(`${name} sorts before an existing migration`);
    }
  }

  // Rule 5: an SQL file that the journal does not name is a migration that never runs.
  if (current.has(JOURNAL)) {
    const named = new Set((currentEntries as JournalEntry[]).map((e) => `${e.tag}.sql`));
    const orphans = [...current.keys()].filter(
      (p) => !p.includes("/") && p.endsWith(".sql") && !named.has(p),
    );
    for (const file of orphans.sort()) problems.push(`${file} has no journal entry`);
  }

  return problems;
}

export function readWorktreeMigrations(folder: string): MigrationTree {
  const tree = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else tree.set(rel, readFileSync(full, "utf8"));
    }
  };
  walk(folder, "");
  return tree;
}

const git = (repoFolder: string, args: string[]) =>
  execFileSync("git", args, { cwd: repoFolder, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export function readGitMigrations(ref: string, repoFolder: string): MigrationTree {
  const tree = new Map<string, string>();
  const names = git(repoFolder, ["ls-tree", "-r", "--name-only", ref, "--", MIGRATIONS_PATH])
    .split("\n")
    .filter(Boolean);
  for (const path of names)
    tree.set(path.slice(MIGRATIONS_PATH.length + 1), git(repoFolder, ["show", `${ref}:${path}`]));
  return tree;
}

export function baseRef(repoFolder: string): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      git(repoFolder, ["rev-parse", "--verify", "--quiet", ref]);
      return ref;
    } catch {
      // try the next one
    }
  }
  throw new Error("forward-only check: no base branch (origin/main or main)");
}
