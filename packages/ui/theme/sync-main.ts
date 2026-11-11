import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diffTree, writeTree } from "./apply.ts";
import { buildImportTree } from "./import-tree.ts";
import { MOCKUP_ASSETS, THEME_MANIFEST, VENDORED_ASSETS, type ThemeManifest } from "./manifest.ts";
import {
  SCRIPT_HASH_FILE,
  buildScriptList,
  formatScriptList,
  scriptHashSet,
} from "./script-hashes.ts";
import { ThemeError, type RefReport, type Tree } from "./tree.ts";

export interface SyncContext {
  repoRoot: string;
  out(line: string): void;
  err(line: string): void;
  /** For tests only: the allow-list of the run. The default is `THEME_MANIFEST`. */
  manifest?: ThemeManifest;
}

export const USAGE: string[] = [
  "usage: node scripts/sync-theme.ts --stage import [--check]",
  "  --stage import  copy the 16.3 allow-list of design/mockup to packages/ui/theme/assets",
  "                  and write the list of the theme's scripts",
  "  --check         write nothing; exit 1 when the copy or the list differs",
  "  --help          print this text",
];

/** The most lines of one kind that a report prints. */
const MAX_DIFF_LINES = 20;
const MAX_DETAIL_LINES = 30;

type Request = { kind: "help" } | { kind: "import"; check: boolean } | { kind: "usage" };

function parse(argv: readonly string[]): Request {
  if (argv.includes("--help")) return { kind: "help" };
  let stage: string | null = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--stage" && stage === null && argv[i + 1] !== undefined) {
      stage = argv[i + 1] ?? "";
      i++;
    } else return { kind: "usage" };
  }
  return stage === "import" ? { kind: "import", check } : { kind: "usage" };
}

function refsLine(refs: RefReport): string {
  return (
    `import: refs: ${refs.shipped} shipped, ${refs.neverShipped.length} never shipped, ` +
    `${refs.knownMissing.length} known missing, ${refs.unshippedFallbacks.length} fallbacks not shipped`
  );
}

function summaryLine(tree: Tree): string {
  const bytes = tree.files.reduce((sum, file) => sum + file.bytes, 0);
  return `import: ${tree.files.length} files, ${bytes} bytes, digest ${tree.digest}`;
}

function readTextOrNull(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function runImport(check: boolean, ctx: SyncContext): number {
  const manifest = ctx.manifest ?? THEME_MANIFEST;
  const dest = join(ctx.repoRoot, VENDORED_ASSETS);
  const listFile = join(ctx.repoRoot, SCRIPT_HASH_FILE);

  // Everything that can refuse is built before anything is written (R16).
  const { tree, refs } = buildImportTree(join(ctx.repoRoot, MOCKUP_ASSETS), manifest);
  const scripts = buildScriptList(join(ctx.repoRoot, "design/mockup"));
  const listText = formatScriptList(scripts);
  const scriptsLine = `import: scripts: ${scripts.length} listed, ${scriptHashSet(scripts).size} hashed`;
  const currentList = readTextOrNull(listFile);

  ctx.out(summaryLine(tree));
  ctx.out(refsLine(refs));

  if (!check) {
    const { written, removed } = writeTree(tree, dest);
    ctx.out(
      `import: ${written.length} written, ${removed.length} removed, ${tree.files.length - written.length} unchanged`,
    );
    const changed = currentList !== listText;
    if (changed) {
      mkdirSync(dirname(listFile), { recursive: true });
      writeFileSync(listFile, listText);
    }
    ctx.out(`${scriptsLine}, ${changed ? "written" : "unchanged"}`);
    return 0;
  }

  const diff = diffTree(tree, dest);
  const treeInSync = diff.missing.length + diff.changed.length + diff.stray.length === 0;
  const listInSync = currentList === listText;
  if (listInSync) ctx.out(`${scriptsLine}, in sync`);
  if (treeInSync) ctx.out("import: in sync");
  else {
    ctx.err(`import: ${dest} differs from what the stage writes`);
    const lines = [
      ...diff.missing.map((path) => `  missing: ${path}`),
      ...diff.changed.map((path) => `  changed: ${path}`),
      ...diff.stray.map((path) => `  stray: ${path}`),
    ];
    for (const line of lines.slice(0, MAX_DIFF_LINES)) ctx.err(line);
  }
  if (!listInSync) ctx.err(`import: ${listFile} differs from what the stage writes`);
  return treeInSync && listInSync ? 0 : 1;
}

/** Runs the command. It never throws; it returns the exit code. */
export function syncThemeMain(argv: readonly string[], ctx: SyncContext): number {
  const request = parse(argv);
  if (request.kind === "help") {
    for (const line of USAGE) ctx.out(line);
    return 0;
  }
  if (request.kind === "usage") {
    for (const line of USAGE) ctx.err(line);
    return 1;
  }
  try {
    return runImport(request.check, ctx);
  } catch (error) {
    if (error instanceof ThemeError) {
      ctx.err(`theme-sync: ${error.message} (${error.code})`);
      for (const detail of error.details.slice(0, MAX_DETAIL_LINES)) ctx.err(`  ${detail}`);
    } else {
      ctx.err(
        `theme-sync: unexpected error: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    return 1;
  }
}
