import { readdirSync } from "node:fs";

export type FileTreeProblem = "symlink" | "special" | "missing";

export class FileTreeError extends Error {
  readonly problem: FileTreeProblem;
  readonly path: string;

  constructor(problem: FileTreeProblem, path: string) {
    super(`${problem}: ${path}`);
    this.name = "FileTreeError";
    this.problem = problem;
    this.path = path;
  }
}

/**
 * `*` is any run of characters except `/`, `**` is any run (a `/` included), everything else is
 * literal. The pattern has to match the whole path.
 */
export function matchPattern(pattern: string, path: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "*") {
      if (pattern.charAt(i + 1) === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "s").test(path);
}

function walk(dir: string, prefix: string, found: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new FileTreeError("symlink", relative);
    if (entry.isDirectory()) walk(`${dir}/${entry.name}`, relative, found);
    else if (entry.isFile()) found.push(relative);
    else throw new FileTreeError("special", relative);
  }
}

/**
 * The regular files below `root`, as paths relative to `root` with `/`, sorted by code unit.
 * A symbolic link, an entry that is neither file nor folder and a missing `root` are refused.
 */
export function listFiles(root: string): string[] {
  const found: string[] = [];
  try {
    walk(root, "", found);
  } catch (error) {
    if (error instanceof FileTreeError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new FileTreeError("missing", root);
    throw error;
  }
  return found.sort();
}
