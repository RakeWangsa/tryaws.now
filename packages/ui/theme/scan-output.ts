import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { refKind, scanCssRefs } from "./css-refs.ts";
import { FORBIDDEN_SEGMENTS, SCRIPT_EXTENSIONS, forbiddenReason } from "./manifest.ts";
import { MIN_HASHED_BYTES, readScriptList, scriptHashSet } from "./script-hashes.ts";
import { ThemeError, listTree, sha256Of } from "./tree.ts";

export type FindingRule =
  | "forbidden-path"
  | "theme-script-bytes"
  | "jquery-signature"
  | "external-reference"
  | "unparsable-css";

/** `file` is the path inside the scanned folder, with `/`. */
export interface Finding {
  readonly rule: FindingRule;
  readonly file: string;
  readonly detail: string;
}

/** Text that survives minification and bundling. */
export const JQUERY_SIGNATURES: readonly string[] = [
  "jQuery requires a window with a document",
  "jquery.org/license",
];

/** The extensions whose text is searched for a signature. */
const SIGNATURE_EXTENSIONS = [".js", ".mjs", ".cjs", ".html", ".txt"] as const;

function hasExtension(lowerPath: string, extensions: readonly string[]): string | undefined {
  return extensions.find((extension) => lowerPath.endsWith(extension));
}

/** Check 1: why the path alone is not allowed in an output, or `null`. */
function pathReason(path: string): string | null {
  const segments = path.split("/");
  const lower = path.toLowerCase();
  const folders = segments.slice(0, -1).map((segment) => segment.toLowerCase());

  for (let i = 0; i < folders.length; i++) {
    if (folders[i] !== "theme" || folders[i + 1] !== "assets") continue;
    const rest = segments.slice(i + 2).join("/");
    const reason = rest === "" ? null : forbiddenReason(rest);
    if (reason !== null) return reason;
  }
  if (folders.includes("theme")) {
    const script = hasExtension(lower, SCRIPT_EXTENSIONS);
    if (script !== undefined) return `a ${script} file in the theme folder (U2)`;
  }
  const outside = hasExtension(lower, [".php", ".tpl"]);
  if (outside !== undefined) return `a ${outside} file (U2)`;
  const segment = FORBIDDEN_SEGMENTS.find((name) => folders.includes(name));
  if (segment !== undefined) return `a file under ${segment}/ (U2)`;
  return null;
}

/**
 * Looks at every file below `dir` by path, by bytes, by signature and (stylesheets) by reference.
 * `hashes` are the sha256 of the theme's scripts. A folder that cannot be read is refused.
 */
export function scanOutput(
  dir: string,
  hashes: ReadonlySet<string>,
): { files: number; findings: Finding[] } {
  const paths = listTree(dir);
  const findings: Finding[] = [];
  for (const path of paths) {
    const add = (rule: FindingRule, detail: string): void => {
      findings.push({ rule, file: path, detail });
    };
    const lower = path.toLowerCase();

    const reason = pathReason(path);
    if (reason !== null) add("forbidden-path", reason);

    const bytes = readFileSync(join(dir, path));
    if (bytes.length >= MIN_HASHED_BYTES && hashes.has(sha256Of(bytes)))
      add("theme-script-bytes", "same bytes as a script of the theme");

    if (hasExtension(lower, SIGNATURE_EXTENSIONS) !== undefined) {
      const text = bytes.toString("latin1");
      const signature = JQUERY_SIGNATURES.find((candidate) => text.includes(candidate));
      if (signature !== undefined)
        add("jquery-signature", `contains the jQuery signature "${signature}"`);
    }

    if (lower.endsWith(".css")) {
      let raws: string[] | null = null;
      try {
        raws = scanCssRefs(bytes.toString("utf8")).map((ref) => ref.raw);
      } catch {
        add("unparsable-css", "cannot be parsed");
      }
      const external = raws?.find((raw) => refKind(raw) === "external");
      if (external !== undefined)
        add("external-reference", `refers to another origin: ${external}`);
    }
  }
  return { files: paths.length, findings };
}

export interface ScanContext {
  cwd: string;
  /** The absolute path of the list of the theme's scripts. */
  hashFile: string;
  out(line: string): void;
  err(line: string): void;
}

export const USAGE: string[] = [
  "usage: node scripts/scan-theme-output.ts <folder>...",
  "  looks in each folder for the theme's scripts, jQuery and other origins (spec 16.16)",
];

const MAX_DETAIL_LINES = 20;

function report(error: unknown, ctx: ScanContext): void {
  if (error instanceof ThemeError) {
    ctx.err(`theme-scan: ${error.message} (${error.code})`);
    for (const detail of error.details.slice(0, MAX_DETAIL_LINES)) ctx.err(`  ${detail}`);
  } else {
    ctx.err(`theme-scan: unexpected error: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

/** Runs the command. It never throws; it returns the exit code. */
export function scanThemeOutputMain(argv: readonly string[], ctx: ScanContext): number {
  if (argv.length === 0 || argv.some((arg) => arg.startsWith("-"))) {
    for (const line of USAGE) ctx.err(line);
    return 1;
  }
  let hashes: Set<string>;
  try {
    hashes = scriptHashSet(readScriptList(ctx.hashFile));
    if (hashes.size === 0)
      throw new ThemeError("missing_input", "the list of the theme's scripts has no hash", [
        ctx.hashFile,
      ]);
  } catch (error) {
    report(error, ctx);
    return 1;
  }
  let clean = true;
  for (const arg of argv) {
    try {
      const { files, findings } = scanOutput(resolve(ctx.cwd, arg), hashes);
      ctx.out(`scanned ${files} files in ${arg}: ${findings.length} findings`);
      for (const finding of findings) {
        ctx.err(`FOUND ${finding.rule} ${finding.file}: ${finding.detail}`);
        clean = false;
      }
    } catch (error) {
      report(error, ctx);
      clean = false;
    }
  }
  return clean ? 0 : 1;
}
