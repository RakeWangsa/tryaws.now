import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { mockupPresent, vendoredThemePresent } from "@tc/ui/theme-present";
import { describe, expect, it, vi } from "vitest";
import { BUCKET_ANCHORS } from "./bucket-anchors.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// Not `new URL(..., import.meta.url)`: under jsdom Vite rewrites that form to an http URL.
const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../../../../../..", "design/mockup");

function tokensOf(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const attribute of text.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") tokens.add(token);
  }
  return tokens;
}
const mockupTokens = (file: string): Set<string> =>
  tokensOf(readFileSync(resolve(mockupRoot, file), "utf8"));

describe("the object storage screens follow the shared mockup", () => {
  for (const row of BUCKET_ANCHORS) {
    it.skipIf(!mockupPresent())(`${row.state} / ${row.mockupFile}: ${row.why}`, () => {
      const inMockup = mockupTokens(row.mockupFile);
      const missingInMockup = row.classes.filter((token) => !inMockup.has(token));
      expect(missingInMockup, `not in ${row.mockupFile}`).toEqual([]);

      const render = STATE_RENDERERS[row.state];
      expect(render, `no renderer for ${row.state}`).toBeDefined();
      for (const locale of ["bn", "en"] as const) {
        const rendered = tokensOf((render as (l: "bn" | "en") => string)(locale));
        const missing = row.classes.filter((token) => !rendered.has(token));
        expect(missing, `${row.state} in ${locale}`).toEqual([]);
      }
    });
  }

  it.skipIf(!vendoredThemePresent())(
    "every class of every rendered state is defined by the theme, Bootstrap, Font Awesome or tc.css",
    () => {
      const known = knownClasses();
      for (const [state, render] of Object.entries(STATE_RENDERERS)) {
        for (const locale of ["bn", "en"] as const) {
          const unknown = [...tokensOf(render(locale))].filter((token) => !known.has(token));
          expect(unknown, `${state} in ${locale}`).toEqual([]);
        }
      }
    },
  );

  it("every state id of a row has a renderer, and every renderer has at least one anchor row", () => {
    for (const row of BUCKET_ANCHORS) expect(STATE_RENDERERS[row.state]).toBeDefined();
    const anchored = new Set(BUCKET_ANCHORS.map((row) => row.state));
    for (const id of Object.keys(STATE_RENDERERS)) expect(anchored.has(id), id).toBe(true);
  });

  it("every screen is shown in loading, error and an empty or flag-off state, in bn and en", () => {
    for (const screen of ["storage", "storage_new", "storage_detail"]) {
      for (const state of ["loading", "error"]) {
        expect(STATE_RENDERERS[`${screen}.${state}`], `${screen}.${state}`).toBeDefined();
      }
    }
    for (const id of [
      "storage.empty",
      "storage.flag_off",
      "storage_new.flag_off",
      "storage_detail.not_found",
    ]) {
      expect(STATE_RENDERERS[id], id).toBeDefined();
    }
  });

  it("no state shows an account id, an ARN or raw error text; the only tc- name is the bucket name (U6, R11)", () => {
    for (const [state, render] of Object.entries(STATE_RENDERERS)) {
      for (const locale of ["bn", "en"] as const) {
        const html = render(locale);
        expect(html, `${state} in ${locale}`).not.toMatch(
          /arn:aws|\b\d{12}\b|raw text must never show/,
        );
        for (const name of html.match(/tc-[a-z]+-[0-9a-f]{6,}/g) ?? []) {
          expect(name, `${state} in ${locale}`).toMatch(/^tc-bucket-[0-9a-f]{16}$/);
        }
      }
    }
  });
});
