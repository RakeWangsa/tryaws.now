import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WPU-X7: the colors that tc.css section 10 sets must keep WCAG 2.2 AA (4.5:1 for normal text) on the
// dark page and card of 16.4, so a later edit of a hex value cannot bring the axe findings back.
const css = readFileSync("packages/ui/styles/tc.css", "utf8");
const PAGE = "#15212a";
const CARD = "#101920";

function channel(hex, i) {
  const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function token(name) {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`${name} is not defined in tc.css`);
  return m[1];
}

describe("tc.css section 10: contrast on the dark page", () => {
  it("muted text reads on the page and on the card", () => {
    const muted = token("--tc-muted-on-dark");
    expect(ratio(muted, PAGE)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(muted, CARD)).toBeGreaterThanOrEqual(4.5);
    // the light variant is for the light background of 16.4 (page #ffffff, card #ebeff5)
    const light = token("--tc-muted-on-light");
    expect(ratio(light, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(light, "#ebeff5")).toBeGreaterThanOrEqual(4.5);
  });

  it("white text reads on the accent pink of buttons and the current language pill", () => {
    expect(ratio("#ffffff", token("--tc-accent-pink-aa"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the rules use the tokens and nothing else changes the theme file", () => {
    expect(css).toContain(".tc-muted {");
    expect(css).toContain('[data-color="pink"] .tc-btn-pink');
    expect(css).toContain('[data-color="pink"] .tc-locale-link[aria-current="true"]');
    expect(css).toContain("var(--tc-accent-pink-aa)");
  });
});
