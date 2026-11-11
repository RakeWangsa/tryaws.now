import { posix } from "node:path";
import { parse } from "postcss";

export interface CssRef {
  readonly raw: string;
  readonly kind: "url" | "import";
}

export type RefKind = "data" | "external" | "root-relative" | "relative";

// url( "x" ) in its three quoting forms; the target is in the first group that matched.
const URL_FUNCTION = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/g;
// The target of @import: a string or url(...), at the start of the parameters.
const IMPORT_TARGET =
  /^\s*(?:"([^"]*)"|'([^']*)'|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\))/;

function firstGroup(match: RegExpMatchArray | RegExpExecArray): string {
  return match.slice(1).find((group) => group !== undefined) ?? "";
}

/**
 * Every `url()` of a declaration and every `@import`, in document order. Comments are not read and
 * a `data:` URI is returned as written. An `@import` that has no readable target is refused.
 */
export function scanCssRefs(css: string): CssRef[] {
  const refs: CssRef[] = [];
  parse(css).walk((node) => {
    if (node.type === "decl") {
      for (const match of node.value.matchAll(URL_FUNCTION))
        refs.push({ raw: firstGroup(match), kind: "url" });
    } else if (node.type === "atrule" && node.name.toLowerCase() === "import") {
      const match = IMPORT_TARGET.exec(node.params);
      if (match === null) throw new Error(`@import without a readable target: ${node.params}`);
      refs.push({ raw: firstGroup(match), kind: "import" });
    }
  });
  return refs;
}

export function refKind(raw: string): RefKind {
  if (/^data:/i.test(raw)) return "data";
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return "external";
  if (raw.startsWith("/")) return "root-relative";
  return "relative";
}

/**
 * The target of `raw` as a path in the tree that holds `fromFile`, without query and fragment.
 * `null` for anything but a relative reference, for an empty path and for a path that leaves the
 * tree.
 */
export function resolveRef(fromFile: string, raw: string): string | null {
  if (refKind(raw) !== "relative") return null;
  const path = raw.split(/[?#]/, 1)[0] ?? "";
  if (path === "") return null;
  const target = posix.normalize(posix.join(posix.dirname(fromFile), path));
  if (target === ".." || target.startsWith("../")) return null;
  return target;
}
