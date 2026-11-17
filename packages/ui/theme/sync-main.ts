import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diffTree, writeTree } from "./apply.ts";
import { fontPackageDir } from "./font-faces.ts";
import { buildImportTree } from "./import-tree.ts";
import {
  APPS,
  MOCKUP_ASSETS,
  TC_CSS,
  THEME_MANIFEST,
  VENDORED_ASSETS,
  appThemeDir,
  type AppName,
  type ThemeManifest,
} from "./manifest.ts";
import { buildPublishTree } from "./publish.ts";
import { scanOutput } from "./scan-output.ts";
import {
  SCRIPT_HASH_FILE,
  buildScriptList,
  formatScriptList,
  readScriptList,
  scriptHashSet,
} from "./script-hashes.ts";
import { ThemeError, type RefReport, type Tree } from "./tree.ts";

export interface SyncContext {
  repoRoot: string;
  out(line: string): void;
  err(line: string): void;
  /** For tests only: the allow-list of the run. The default is `THEME_MANIFEST`. */
  manifest?: ThemeManifest;
  /** For tests only: where the installed Fontsource packages are. The default is the real ones. */
  fontPackageDir?(packageName: string): string;
}

export const USAGE: string[] = [
  "usage: node scripts/sync-theme.ts [--stage import|publish] [--app web|admin] [--check]",
  "  --stage import   copy the 16.3 allow-list of design/mockup to packages/ui/theme/assets",
  "                   and write the list of the theme's scripts",
  "  --stage publish  write public/theme of the apps from the committed copy, tc.css and the",
  "                   installed fonts, then scan what was written (needs no design/)",
  "                   without --stage: import, then publish",
  "  --app            publish: only this app (web or admin); the default is both",
  "  --check          write nothing; exit 1 when a copy, the list or a public/theme differs",
  "  --help           print this text",
  "",
  "The Antler theme is a paid third-party product and is not in a public checkout. Without",
  "design/mockup, import does nothing and exits 0. Without packages/ui/theme/assets, publish writes",
  "tc.css and the fonts only (the theme-less mode) and exits 0, so that next build works.",
  "Bring your own licensed copy: docs/theme.md",
];

/** The most lines of one kind that a report prints. */
const MAX_DIFF_LINES = 20;
const MAX_DETAIL_LINES = 30;

type Stage = "import" | "publish";
type Request =
  | { kind: "help" }
  | { kind: "run"; stages: readonly Stage[]; app: AppName | null; check: boolean }
  | { kind: "usage" };

function isApp(value: string): value is AppName {
  return (APPS as readonly string[]).includes(value);
}

function parse(argv: readonly string[]): Request {
  if (argv.includes("--help")) return { kind: "help" };
  let stage: string | null = null;
  let app: AppName | null = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--check") check = true;
    else if (arg === "--stage" && stage === null && value !== undefined) {
      stage = value;
      i++;
    } else if (arg === "--app" && app === null && value !== undefined && isApp(value)) {
      app = value;
      i++;
    } else return { kind: "usage" };
  }
  if (stage === null) return { kind: "run", stages: ["import", "publish"], app, check };
  if (stage === "import" || stage === "publish")
    return { kind: "run", stages: [stage], app, check };
  return { kind: "usage" };
}

function refsLine(label: string, refs: RefReport): string {
  return (
    `${label}: refs: ${refs.shipped} shipped, ${refs.neverShipped.length} never shipped, ` +
    `${refs.knownMissing.length} known missing, ${refs.unshippedFallbacks.length} fallbacks not shipped`
  );
}

function summaryLine(label: string, tree: Tree): string {
  const bytes = tree.files.reduce((sum, file) => sum + file.bytes, 0);
  return `${label}: ${tree.files.length} files, ${bytes} bytes, digest ${tree.digest}`;
}

function readTextOrNull(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

const noticePrinted = new WeakSet<SyncContext>();

/**
 * The theme-less mode (docs/theme.md): printed once per run, at the first stage that needs the theme.
 * `missing` names the folders that are not there. It is a notice, not an error: a public checkout has
 * no theme by design, and the exit code stays 0 (WPU-X30a).
 */
function themeLessNotice(missing: readonly string[], ctx: SyncContext): void {
  if (noticePrinted.has(ctx)) return;
  noticePrinted.add(ctx);
  ctx.out("theme-sync: the Antler theme is not in this checkout (theme-less mode).");
  ctx.out(
    "  Antler is a paid third-party theme (Envato). It is not part of the public repository.",
  );
  for (const folder of missing) ctx.out(`  missing: ${folder}`);
  ctx.out(
    "  Without it the apps build, with tc.css and the self-hosted fonts and no theme styling.",
  );
  ctx.out("  To use your own licensed copy, follow docs/theme.md");
}

function runImport(check: boolean, ctx: SyncContext): number {
  // No mockup, nothing to import (and nothing to compare a vendored copy with): say so and stop.
  if (!existsSync(join(ctx.repoRoot, MOCKUP_ASSETS))) {
    themeLessNotice(
      [
        MOCKUP_ASSETS,
        ...(existsSync(join(ctx.repoRoot, VENDORED_ASSETS)) ? [] : [VENDORED_ASSETS]),
      ],
      ctx,
    );
    ctx.out(`import: skipped, ${MOCKUP_ASSETS} is absent`);
    return 0;
  }
  const manifest = ctx.manifest ?? THEME_MANIFEST;
  const dest = join(ctx.repoRoot, VENDORED_ASSETS);
  const listFile = join(ctx.repoRoot, SCRIPT_HASH_FILE);

  // Everything that can refuse is built before anything is written (R16).
  const { tree, refs } = buildImportTree(join(ctx.repoRoot, MOCKUP_ASSETS), manifest);
  const scripts = buildScriptList(join(ctx.repoRoot, "design/mockup"));
  const listText = formatScriptList(scripts);
  const scriptsLine = `import: scripts: ${scripts.length} listed, ${scriptHashSet(scripts).size} hashed`;
  const currentList = readTextOrNull(listFile);

  ctx.out(summaryLine("import", tree));
  ctx.out(refsLine("import", refs));

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

function diffLines(diff: { missing: string[]; changed: string[]; stray: string[] }): string[] {
  return [
    ...diff.missing.map((path) => `  missing: ${path}`),
    ...diff.changed.map((path) => `  changed: ${path}`),
    ...diff.stray.map((path) => `  stray: ${path}`),
  ];
}

/** Scans the folder of one app. Returns true when it is clean. */
function scanApp(
  label: string,
  dest: string,
  hashes: ReadonlySet<string>,
  ctx: SyncContext,
): boolean {
  const { files, findings } = scanOutput(dest, hashes);
  ctx.out(`${label}: scanned ${files} files, ${findings.length} findings`);
  for (const finding of findings)
    ctx.err(`FOUND ${finding.rule} ${finding.file}: ${finding.detail}`);
  return findings.length === 0;
}

function runPublish(app: AppName | null, check: boolean, ctx: SyncContext): number {
  const manifest = ctx.manifest ?? THEME_MANIFEST;
  // The theme-less mode is chosen only when the whole vendored folder is absent. A folder that is
  // there is read in full, so a damaged licensed checkout still fails (R16).
  const themeLess = !existsSync(join(ctx.repoRoot, VENDORED_ASSETS));
  if (themeLess) themeLessNotice([VENDORED_ASSETS], ctx);
  const { tree, refs } = buildPublishTree({
    vendoredRoot: join(ctx.repoRoot, VENDORED_ASSETS),
    tcCssFile: join(ctx.repoRoot, TC_CSS),
    fontPackageDir: ctx.fontPackageDir ?? fontPackageDir,
    repoRoot: ctx.repoRoot,
    manifest,
    themeLess,
  });
  // The scan needs the theme's scripts; without them nothing is written (R16). The theme-less tree
  // holds no file of the theme, so there is nothing to match and the list may be empty.
  const listFile = join(ctx.repoRoot, SCRIPT_HASH_FILE);
  const hashes =
    themeLess && !existsSync(listFile)
      ? new Set<string>()
      : scriptHashSet(readScriptList(listFile));
  if (hashes.size === 0 && !themeLess)
    throw new ThemeError("missing_input", "the list of the theme's scripts has no hash", [
      SCRIPT_HASH_FILE,
    ]);

  ctx.out(summaryLine("publish", tree));
  ctx.out(refsLine("publish", refs));

  let clean = true;
  for (const name of app === null ? APPS : [app]) {
    const label = `publish ${name}`;
    const dest = join(ctx.repoRoot, appThemeDir(name));
    if (!check) {
      const { written, removed } = writeTree(tree, dest);
      ctx.out(
        `${label}: ${written.length} written, ${removed.length} removed, ${tree.files.length - written.length} unchanged`,
      );
      if (!scanApp(label, dest, hashes, ctx)) clean = false;
      continue;
    }
    const diff = diffTree(tree, dest);
    if (diff.missing.length + diff.changed.length + diff.stray.length > 0 || !existsSync(dest)) {
      ctx.err(`${label}: ${dest} differs from what the stage writes`);
      for (const line of diffLines(diff).slice(0, MAX_DIFF_LINES)) ctx.err(line);
      clean = false;
      continue;
    }
    ctx.out(`${label}: in sync`);
    if (!scanApp(label, dest, hashes, ctx)) clean = false;
  }
  return clean ? 0 : 1;
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
    let code = 0;
    for (const stage of request.stages) {
      const stageCode =
        stage === "import"
          ? runImport(request.check, ctx)
          : runPublish(request.app, request.check, ctx);
      code = Math.max(code, stageCode);
    }
    return code;
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
