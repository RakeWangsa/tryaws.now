import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FILES = ["logo.svg", "logo-light.svg", "symbol.svg"] as const;
// The namespace declaration is the one URL an image file needs; it is not a reference.
const SVG_NAMESPACE = 'xmlns="http://www.w3.org/2000/svg"';

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./public/brand/${name}`, import.meta.url)), "utf8");
}

describe("apps/admin/public/brand", () => {
  it.each(FILES)("%s is small, has a viewBox and holds nothing active or external", (name) => {
    const svg = read(name);
    expect(Buffer.byteLength(svg)).toBeLessThan(4096);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox=");
    const rest = svg.replace(SVG_NAMESPACE, "");
    for (const forbidden of [
      "<script",
      "<style",
      "href=",
      "http://",
      "https://",
      "<foreignObject",
    ]) {
      expect(rest, forbidden).not.toContain(forbidden);
    }
  });
});
