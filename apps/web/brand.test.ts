import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = ["logo.svg", "logo-light.svg", "symbol.svg"] as const;
const SOURCE = new URL("../../design/brand/", import.meta.url);
const WEB = new URL("./public/brand/", import.meta.url);
const ADMIN = new URL("../admin/public/brand/", import.meta.url);

function read(dir: URL, name: string): Buffer {
  return readFileSync(new URL(name, dir));
}

describe("placeholder brand files", () => {
  it("exist in design/brand and are byte-equal in apps/web/public/brand", () => {
    for (const name of FILES) {
      expect(read(WEB, name).equals(read(SOURCE, name)), name).toBe(true);
    }
  });

  // The admin copies are made by Task 8, which removes the condition.
  it.skipIf(!existsSync(ADMIN))("are byte-equal in apps/admin/public/brand", () => {
    for (const name of FILES) {
      expect(read(ADMIN, name).equals(read(SOURCE, name)), name).toBe(true);
    }
  });

  it("are under 4096 bytes, start with <svg and have a viewBox", () => {
    for (const name of FILES) {
      const file = read(SOURCE, name);
      expect(file.length, name).toBeLessThan(4096);
      const text = file.toString("utf8");
      expect(text.startsWith("<svg"), name).toBe(true);
      expect(text, name).toContain("viewBox=");
    }
  });

  it("hold no script, style, link, external URL or foreignObject", () => {
    for (const name of FILES) {
      // The one namespace declaration an SVG file needs to work in an <img> is the only URL allowed.
      const text = read(SOURCE, name)
        .toString("utf8")
        .replace('xmlns="http://www.w3.org/2000/svg"', "");
      for (const forbidden of [
        "<script",
        "<style",
        "href=",
        "http://",
        "https://",
        "<foreignObject",
      ]) {
        expect(text, `${name} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
