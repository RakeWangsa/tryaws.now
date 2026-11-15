import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { messageKeys, forbiddenWording } from "@tc/ui";
import { knownClasses } from "@tc/ui/class-inventory";
import type { Locale } from "@tc/ui/runtime";
import { describe, expect, it, vi } from "vitest";
import { windowsAccessBn } from "../../../../../messages/windows-access-bn.ts";
import { windowsAccessEn } from "../../../../../messages/windows-access-en.ts";
import { html } from "../mockup-states.tsx";

// WPU-X23: the detail page mounts AutoRefresh (a client component that reads the router).
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { detail } from "../servers.fixtures.ts";
import { ServerDetailContent } from "./ServerDetailContent.tsx";
import { WindowsAccess } from "./WindowsAccess.tsx";

// The cross-check of the Windows part of the Access tab against the shared mockup (U1), in the way of
// ../mockup-anchors.test.tsx. The mockup pages that stand for it: the service detail of the client area
// (whmcs-template/antler/clientareaproductdetails.tpl) and the tabs of template/checkout.html.

const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../../../../../../..", "design/mockup");
const RES = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "tc-test-windows-password-value-123";
const never = async (): Promise<never> => {
  throw new Error("not called when rendering");
};

function tokens(text: string, attr: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(attr)) {
    for (const t of (m[1] ?? "").split(/\s+/)) if (t !== "") out.add(t);
  }
  return out;
}
const mockupTokens = (file: string) =>
  tokens(readFileSync(resolve(mockupRoot, file), "utf8"), /class\s*=\s*"([^"]*)"/g);

const STATES: Record<string, (l: Locale) => string> = {
  "windows.ready": (l) => html(<WindowsAccess resourceId={RES} running action={never} />, l),
  "windows.not_ready": (l) =>
    html(<WindowsAccess resourceId={RES} running={false} action={never} />, l),
  "windows.revealed": (l) =>
    html(
      <WindowsAccess
        resourceId={RES}
        running
        action={never}
        initial={{ username: "Administrator", password: SECRET }}
      />,
      l,
    ),
};

const ANCHORS = [
  {
    state: "windows.ready",
    file: "whmcs-template/antler/clientareaproductdetails.tpl",
    classes: ["alert", "alert-warning", "btn", "mergecolor"],
  },
  { state: "windows.ready", file: "template/checkout.html", classes: ["seccolor"] },
  {
    state: "windows.not_ready",
    file: "template/checkout.html",
    classes: ["seccolor", "mergecolor"],
  },
  {
    state: "windows.revealed",
    file: "whmcs-template/antler/clientareaproductdetails.tpl",
    classes: ["alert", "btn"],
  },
] as const;

describe("the Windows part of the Access tab follows the shared mockup", () => {
  for (const row of ANCHORS) {
    it(`${row.state} / ${row.file}`, () => {
      const inMockup = mockupTokens(row.file);
      expect(row.classes.filter((c) => !inMockup.has(c))).toEqual([]);
      for (const locale of ["bn", "en"] as const) {
        const rendered = tokens(STATES[row.state]!(locale), /class="([^"]*)"/g);
        expect(
          row.classes.filter((c) => !rendered.has(c)),
          `${row.state} ${locale}`,
        ).toEqual([]);
      }
    });
  }

  it("every class rendered is defined by the theme, Bootstrap, Font Awesome or tc.css", () => {
    const known = knownClasses();
    for (const [state, render] of Object.entries(STATES)) {
      for (const locale of ["bn", "en"] as const) {
        const unknown = [...tokens(render(locale), /class="([^"]*)"/g)].filter(
          (c) => !known.has(c),
        );
        expect(unknown, `${state} ${locale}`).toEqual([]);
      }
    }
  });

  it("the password is never in the server HTML, in any state (U9)", () => {
    for (const render of Object.values(STATES)) {
      for (const locale of ["bn", "en"] as const) expect(render(locale)).not.toContain(SECRET);
    }
  });

  it("the ready state offers the button and says to change the password; not-ready offers none", () => {
    expect(STATES["windows.ready"]!("en")).toContain('type="submit"');
    expect(STATES["windows.ready"]!("en")).toContain("Change it at your first sign-in");
    expect(STATES["windows.not_ready"]!("en")).not.toContain('type="submit"');
    expect(STATES["windows.ready"]!("bn")).toMatch(/[ঀ-৿]/);
  });

  it("the detail page of a Windows server shows the Windows access, not the SSH command", () => {
    const win = detail({ family: "windows_instance", keyName: null });
    const en = html(<ServerDetailContent locale="en" numerals="latn" server={win} />, "en");
    expect(en).toContain("Change it at your first sign-in");
    expect(en).toContain("Remote Desktop address");
    expect(en).toContain('type="submit"');
    expect(en).not.toContain("SSH command");
    const stopped = detail({ family: "windows_instance", state: "creating" });
    expect(
      html(<ServerDetailContent locale="en" numerals="latn" server={stopped} />, "en"),
    ).not.toContain('type="submit"');
    const linux = html(<ServerDetailContent locale="en" numerals="latn" server={detail()} />, "en");
    expect(linux).toContain("SSH command");
    expect(linux).not.toContain("Change it at your first sign-in");
  });

  it("bn and en have the same keys, none empty, no forbidden wording", () => {
    expect(messageKeys(windowsAccessBn)).toEqual(messageKeys(windowsAccessEn));
    for (const tree of [windowsAccessBn, windowsAccessEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      expect(JSON.stringify(tree)).not.toMatch(/arn:aws|\b\d{12}\b/);
    }
  });
});
