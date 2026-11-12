import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { describe, expect, it, vi } from "vitest";
import { EXTRAS_ANCHORS } from "./mockup-anchors.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// Not `new URL(..., import.meta.url)`: under jsdom Vite rewrites that form to an http URL.
const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../../../../../..", "design/mockup");

function tokensOf(text: string, pattern: RegExp): Set<string> {
  const tokens = new Set<string>();
  for (const attribute of text.matchAll(pattern)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") tokens.add(token);
  }
  return tokens;
}
const mockupTokens = (file: string) =>
  tokensOf(readFileSync(resolve(mockupRoot, file), "utf8"), /class\s*=\s*"([^"]*)"/g);
const renderedTokens = (html: string) => tokensOf(html, /class="([^"]*)"/g);

describe("the screens of WP5-T6 follow the shared mockup (U1)", () => {
  for (const row of EXTRAS_ANCHORS) {
    it(`${row.state} / ${row.mockupFile}: ${row.why}`, () => {
      const missingInMockup = row.classes.filter(
        (token) => !mockupTokens(row.mockupFile).has(token),
      );
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

  it("every state that has a renderer has an anchor row, and every anchor has a renderer", () => {
    const anchored = new Set(EXTRAS_ANCHORS.map((row) => row.state));
    for (const id of Object.keys(STATE_RENDERERS)) expect(anchored.has(id), id).toBe(true);
    for (const id of anchored) expect(STATE_RENDERERS[id], id).toBeDefined();
  });

  it("every screen has loading, error and an empty or flag-off state (U11)", () => {
    for (const screen of ["dashboard", "notifications", "tabs"]) {
      for (const state of ["loading", "error"]) {
        expect(STATE_RENDERERS[`${screen}.${state}`], `${screen}.${state}`).toBeDefined();
      }
    }
    for (const id of ["dashboard.empty", "dashboard.flag_off", "notifications.empty"]) {
      expect(STATE_RENDERERS[id], id).toBeDefined();
    }
  });

  it("no inline style attribute and no script file in any state (U2, U4; the replay script of React forms is the Next.js one)", () => {
    for (const [state, render] of Object.entries(STATE_RENDERERS)) {
      for (const locale of ["bn", "en"] as const) {
        const out = render(locale);
        expect(out, `${state} ${locale}`).not.toMatch(/\sstyle="|<script[^>]*\ssrc=/);
      }
    }
  });

  it("no state shows an AWS account id, an ARN, a generated AWS name or raw error text (U6, R11)", () => {
    for (const [state, render] of Object.entries(STATE_RENDERERS)) {
      for (const locale of ["bn", "en"] as const) {
        expect(render(locale), `${state} in ${locale}`).not.toMatch(
          /arn:aws|\b\d{12}\b|tc-[a-z]+-[0-9a-f]{6}|raw text must never show/,
        );
      }
    }
  });

  it("the Metrics tab says 'not available' without a reader, and draws a chart with one", () => {
    const html = (id: string, locale: "bn" | "en") =>
      (STATE_RENDERERS[id] as (l: "bn" | "en") => string)(locale);
    expect(html("tabs.metrics_unavailable", "en")).toContain("Metrics are not available now");
    // WPU-G4: an SVG with a value axis, a time axis and an area, and no chart library or script.
    for (const locale of ["en", "bn"] as const) {
      const chart = html("tabs.ready", locale);
      expect(chart).toContain('viewBox="0 0 640 220"');
      expect(chart).toContain("<path");
      expect(chart).toContain("<title>");
      expect(chart).not.toContain("<polyline");
    }
  });

  it("the Destroy tab names the keep and delete lists and the Billing tab shows the exact total", () => {
    const en = (STATE_RENDERERS["tabs.ready"] as (l: "bn" | "en") => string)("en");
    expect(en).toContain("What is kept");
    expect(en).toContain("Your manual backups (1)");
    expect(en).toContain("690.00");
  });

  it("the final backup has no delete button", () => {
    const en = (STATE_RENDERERS["tabs.ready"] as (l: "bn" | "en") => string)("en");
    // one manual backup row: one "Delete" button in the Backups table
    expect(en.match(/>Delete</g)?.length ?? 0).toBe(1);
  });
});
