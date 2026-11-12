import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { describe, expect, it, vi } from "vitest";
import { DOMAIN_ANCHORS } from "./mockup-anchors.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

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

describe("the domain screens follow the shared mockup", () => {
  for (const row of DOMAIN_ANCHORS) {
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

  it("every state id of a row has a renderer, and every renderer has at least one anchor row", () => {
    for (const row of DOMAIN_ANCHORS) expect(STATE_RENDERERS[row.state]).toBeDefined();
    const anchored = new Set(DOMAIN_ANCHORS.map((row) => row.state));
    for (const id of Object.keys(STATE_RENDERERS)) expect(anchored.has(id), id).toBe(true);
  });

  it("every screen is shown in loading, error and an empty or flag-off state, in bn and en", () => {
    for (const screen of ["domains", "domain_new", "domain_detail"]) {
      for (const state of ["loading", "error"]) {
        expect(STATE_RENDERERS[`${screen}.${state}`], `${screen}.${state}`).toBeDefined();
      }
    }
    for (const id of ["domains.empty", "domains.flag_off", "domain_new.flag_off", "domain_detail.not_found"]) {
      expect(STATE_RENDERERS[id], id).toBeDefined();
    }
  });

  it("no state shows an AWS account id, an ARN, a generated AWS name or raw error text (U6, R11)", () => {
    for (const [state, render] of Object.entries(STATE_RENDERERS)) {
      for (const locale of ["bn", "en"] as const) {
        const html = render(locale);
        expect(html, `${state} in ${locale}`).not.toMatch(
          /arn:aws|\b\d{12}\b|tc-[a-z]+-[0-9a-f]{6}|raw text must never show/,
        );
      }
    }
  });
});
