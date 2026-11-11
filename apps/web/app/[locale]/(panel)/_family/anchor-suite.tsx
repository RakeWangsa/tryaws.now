import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { describe, expect, it } from "vitest";
import type { MockupAnchor } from "./anchors.ts";

// The test suite behind the rows of anchors.ts, shared by the database and load balancer screens.
// Used by the mockup-anchors tests only (never by a page).

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/app/[locale]/(panel)/_family -> the repository root
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

type Renderer = (locale: "bn" | "en") => string;

export function defineAnchorSuite(input: {
  title: string;
  anchors: readonly MockupAnchor[];
  renderers: Readonly<Record<string, Renderer>>;
  /** The screen ids that must show loading and error. */
  screens: readonly string[];
  /** State ids that must exist besides loading and error (empty, flag off, not found). */
  required: readonly string[];
}): void {
  const { anchors, renderers } = input;
  describe(input.title, () => {
    for (const row of anchors) {
      it(`${row.state} / ${row.mockupFile}: ${row.why}`, () => {
        const inMockup = mockupTokens(row.mockupFile);
        const missingInMockup = row.classes.filter((token) => !inMockup.has(token));
        expect(missingInMockup, `not in ${row.mockupFile}`).toEqual([]);

        const render = renderers[row.state];
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
      for (const [state, render] of Object.entries(renderers)) {
        for (const locale of ["bn", "en"] as const) {
          const unknown = [...renderedTokens(render(locale))].filter((token) => !known.has(token));
          expect(unknown, `${state} in ${locale}`).toEqual([]);
        }
      }
    });

    it("every state id of a row has a renderer, and every renderer has at least one anchor row", () => {
      for (const row of anchors) expect(renderers[row.state]).toBeDefined();
      const anchored = new Set(anchors.map((row) => row.state));
      for (const id of Object.keys(renderers)) expect(anchored.has(id), id).toBe(true);
    });

    it("every screen is shown in loading, error and an empty or flag-off state, in bn and en", () => {
      for (const screen of input.screens) {
        for (const state of ["loading", "error"]) {
          expect(renderers[`${screen}.${state}`], `${screen}.${state}`).toBeDefined();
        }
      }
      for (const id of input.required) expect(renderers[id], id).toBeDefined();
    });

    it("no state shows an AWS account id, an ARN, a generated AWS name or raw error text (U6, R11)", () => {
      for (const [state, render] of Object.entries(renderers)) {
        for (const locale of ["bn", "en"] as const) {
          const html = render(locale);
          expect(html, `${state} in ${locale}`).not.toMatch(
            /arn:aws|\b\d{12}\b|tc-[a-z]+-[0-9a-f]{6}|raw text must never show/,
          );
        }
      }
    });
  });
}
