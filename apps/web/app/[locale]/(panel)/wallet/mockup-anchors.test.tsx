import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { antlerThemePresent, mockupPresent, vendoredThemePresent } from "@tc/ui/theme-present";
import { describe, expect, it, vi } from "vitest";
import { EXPLAINED_EXCEPTIONS, WALLET_ANCHORS } from "./mockup-anchors.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

// The Server Actions are replaced: the screens only need a function to post to, and the client
// router is not available outside Next.
vi.mock("./topup/actions.ts", () => ({ startTopUpAction: async () => ({ status: "idle" }) }));
vi.mock("./topup/[paymentId]/actions.ts", () => ({
  recheckPaymentAction: async () => ({ state: "pending", review: false }),
  checkAgainAction: async () => {},
}));
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

describe("the wallet screens follow the shared mockup", () => {
  for (const row of WALLET_ANCHORS) {
    it.skipIf(!mockupPresent())(`${row.state} / ${row.mockupFile}: ${row.why}`, () => {
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

  it.skipIf(!vendoredThemePresent())(
    "every class of every rendered state is defined by the theme, Bootstrap, Font Awesome or tc.css",
    () => {
      const known = knownClasses();
      for (const [state, render] of Object.entries(STATE_RENDERERS)) {
        for (const locale of ["bn", "en"] as const) {
          const unknown = [...renderedTokens(render(locale))].filter((token) => !known.has(token));
          expect(unknown, `${state} in ${locale}`).toEqual([]);
        }
      }
    },
  );

  it("every state id of a row has a renderer", () => {
    for (const row of WALLET_ANCHORS) expect(STATE_RENDERERS[row.state]).toBeDefined();
  });

  it("the top-up and status states are all covered by a row", () => {
    const covered = new Set(WALLET_ANCHORS.map((row) => row.state));
    for (const id of Object.keys(STATE_RENDERERS)) {
      if (!id.startsWith("topup.") && !id.startsWith("status.")) continue;
      // topup.form.noquick, topup.closed.noeps and topup.error.rate_limited share the rows of their screen.
      const base = id.replace(/\.(noquick|noeps|rate_limited)$/, (m) =>
        m === ".rate_limited" ? ".unavailable" : "",
      );
      expect(covered.has(base) || covered.has(id), id).toBe(true);
    }
  });
});

describe("classes of the mockup that the screens do not carry are explained (open point 11)", () => {
  // Lazy: a skipped test still runs this body, and knownClasses() refuses without the theme.
  const known = () => knownClasses();
  const topupAndStatus = Object.entries(STATE_RENDERERS).filter(
    ([id]) => id.startsWith("topup.") || id.startsWith("status."),
  );

  for (const exception of EXPLAINED_EXCEPTIONS) {
    it.skipIf(!antlerThemePresent())(
      `${exception.cls} (${exception.mockupFile}) is in the mockup, is not rendered, and its replacement is`,
      () => {
        expect(mockupTokens(exception.mockupFile).has(exception.cls)).toBe(true);
        for (const [id, render] of topupAndStatus) {
          for (const locale of ["bn", "en"] as const) {
            const rendered = renderedTokens(render(locale));
            expect(rendered.has(exception.cls), `${id} ${locale}`).toBe(false);
          }
        }
        // Each replacement is a class the build defines and that some state really uses.
        const all = new Set<string>();
        for (const [, render] of topupAndStatus) {
          for (const token of renderedTokens(render("en"))) all.add(token);
        }
        for (const replacement of exception.replacedBy) {
          expect(known().has(replacement), `${replacement} is defined`).toBe(true);
          expect(all.has(replacement), `${replacement} is rendered`).toBe(true);
        }
      },
    );
  }
});
