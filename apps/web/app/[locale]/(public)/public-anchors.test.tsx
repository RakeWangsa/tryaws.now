import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EXPLAINED_EXCEPTIONS, PUBLIC_ANCHORS } from "./public-anchors.ts";
import { UNAVAILABLE, openCatalog } from "./public.fixtures.ts";
import { renderers } from "./public-states.tsx";
import type { Renderer } from "./public-states.tsx";

// The Server Action is replaced: the page only needs a function to post to.
vi.mock("./products/[family]/actions.ts", () => ({
  notifyMeAction: async () => ({ status: "idle" }),
}));

// Not `new URL(..., import.meta.url)`: under jsdom Vite rewrites that form to an http URL.
const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../../../../..", "design/mockup");

function mockupTokens(file: string): Set<string> {
  const text = readFileSync(resolve(mockupRoot, file), "utf8");
  const tokens = new Set<string>();
  for (const attribute of text.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") tokens.add(token);
  }
  return tokens;
}

function renderedTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const attribute of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") tokens.add(token);
  }
  return tokens;
}

let states: Record<string, Renderer>;
beforeAll(async () => {
  states = renderers(await openCatalog(), UNAVAILABLE);
});

describe("the public pages follow the shared mockup", () => {
  for (const row of PUBLIC_ANCHORS) {
    it(`${row.state} / ${row.mockupFile}: ${row.why}`, () => {
      const inMockup = mockupTokens(row.mockupFile);
      const missingInMockup = row.classes.filter((token) => !inMockup.has(token));
      expect(missingInMockup, `not in ${row.mockupFile}`).toEqual([]);

      const render = states[row.state];
      expect(render, `no renderer for ${row.state}`).toBeDefined();
      for (const locale of ["bn", "en"] as const) {
        const rendered = renderedTokens((render as Renderer)(locale));
        const missing = row.classes.filter((token) => !rendered.has(token));
        expect(missing, `${row.state} in ${locale}`).toEqual([]);
      }
    });
  }

  it("every class of every rendered state is defined by the theme, Bootstrap, Font Awesome or tc.css", () => {
    const known = knownClasses();
    // `navbar-right` is a class of the public shell (packages/ui, WPU): Bootstrap 5 dropped it, so it
    // does nothing; it is not a class of these pages.
    const SHELL_ONLY = new Set(["navbar-right"]);
    for (const [state, render] of Object.entries(states)) {
      for (const locale of ["bn", "en"] as const) {
        const unknown = [...renderedTokens(render(locale))].filter(
          (token) => !known.has(token) && !SHELL_ONLY.has(token),
        );
        expect(unknown, `${state} in ${locale}`).toEqual([]);
      }
    }
  });

  it("every page of 16.8 that this task builds has a row", () => {
    const covered = new Set(PUBLIC_ANCHORS.map((row) => row.state.split(".")[0]));
    for (const page of [
      "home",
      "pricing",
      "cloud",
      "help",
      "support",
      "legal",
      "family",
      "maintenance",
    ]) {
      expect(covered.has(page), page).toBe(true);
    }
  });

  it("an explained exception is in its mockup file and in no rendered state", () => {
    for (const exception of EXPLAINED_EXCEPTIONS) {
      expect(mockupTokens(exception.mockupFile).has(exception.cls), exception.cls).toBe(true);
      for (const [state, render] of Object.entries(states)) {
        expect(renderedTokens(render("en")).has(exception.cls), `${state} ${exception.cls}`).toBe(
          false,
        );
      }
      const known = knownClasses();
      for (const replacement of exception.replacedBy) expect(known.has(replacement)).toBe(true);
    }
  });
});
