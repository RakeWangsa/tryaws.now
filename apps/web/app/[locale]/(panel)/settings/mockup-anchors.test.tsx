import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { describe, expect, it } from "vitest";
import { SETTINGS_ANCHORS } from "./mockup-anchors.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

// Not `new URL(..., import.meta.url)`: under jsdom Vite rewrites that form to an http URL.
const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../../../../../..", "design/mockup");

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

describe("the settings screens follow the shared mockup", () => {
  for (const row of SETTINGS_ANCHORS) {
    it(`${row.state} / ${row.mockupFile}: ${row.why}`, () => {
      const inMockup = mockupTokens(row.mockupFile);
      const missingInMockup = row.classes.filter((token) => !inMockup.has(token));
      expect(missingInMockup, `not in ${row.mockupFile}`).toEqual([]);

      const render = STATE_RENDERERS[row.state];
      expect(render, `no renderer for ${row.state}`).toBeDefined();
      for (const locale of ["bn", "en"] as const) {
        const rendered = renderedTokens((render as (l: "bn" | "en") => string)(locale));
        const missing = row.classes.filter((token) => !rendered.has(token));
        expect(missing, `${row.state} in ${locale}`).toEqual([]);
      }
    });
  }

  it("every class of every rendered state is defined by the theme, Bootstrap, Font Awesome or tc.css", () => {
    const known = knownClasses();
    for (const [state, render] of Object.entries(STATE_RENDERERS)) {
      for (const locale of ["bn", "en"] as const) {
        const unknown = [...renderedTokens(render(locale))].filter((token) => !known.has(token));
        expect(unknown, `${state} in ${locale}`).toEqual([]);
      }
    }
  });

  it("every state id of a row has a renderer", () => {
    for (const row of SETTINGS_ANCHORS) expect(STATE_RENDERERS[row.state]).toBeDefined();
  });
});
