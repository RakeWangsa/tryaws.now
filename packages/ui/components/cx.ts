/** Joins the truthy parts with one space: `cx("a", false, "b")` is `"a b"`. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
