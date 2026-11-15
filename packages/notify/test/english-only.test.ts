import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEMPLATE_IDS } from "../queue/types";
import { renderCognitoMessage } from "../templates/cognito";
import { notifyLocale, setNotifyEnglishOnly } from "../templates/locale";
import {
  parseTemplateData,
  renderEmail,
  renderInApp,
  renderSms,
  type RenderContext,
} from "../templates/render";
import { SAMPLES } from "./samples";

// WPU-X22 (owner, 2026-11-15): every notification is English, whatever the stored locale. The other
// test files run with the rule off (bengali-texts.setup.ts) to keep the Bengali texts covered.
const BENGALI = /[ঀ-৿]/;
const ctx = (locale: "bn" | "en"): RenderContext => ({
  locale,
  numerals: "beng",
  panelOrigin: "https://my.ticoncloud.test",
});

beforeAll(() => setNotifyEnglishOnly(true));
afterAll(() => setNotifyEnglishOnly(false));

describe("English only (WPU-X22)", () => {
  it("notifyLocale is en for both stored values", () => {
    expect(notifyLocale("bn")).toBe("en");
    expect(notifyLocale("en")).toBe("en");
  });

  it.each(TEMPLATE_IDS)("%s renders the same, in English, for a bn customer", (id) => {
    const data = parseTemplateData(id, SAMPLES[id].data);
    const bn = renderEmail(id, data, ctx("bn"));
    const en = renderEmail(id, data, ctx("en"));
    expect(bn).toEqual(en);
    expect(bn.html).toContain('<html lang="en"');
    for (const s of [bn.subject, bn.text, bn.html]) expect(s).not.toMatch(BENGALI);
    expect(renderSms(id, data, ctx("bn"))).toEqual(renderSms(id, data, ctx("en")));
    expect(renderSms(id, data, ctx("bn")) ?? "").not.toMatch(BENGALI);
    const inApp = renderInApp(id, data, ctx("bn"));
    expect(inApp).toEqual(renderInApp(id, data, ctx("en")));
    expect(JSON.stringify(inApp)).not.toMatch(BENGALI);
    // the link goes to the English panel
    expect(inApp.href).toContain("/en");
  });

  it("the Cognito messages are English for bn", () => {
    for (const kind of ["verify_code", "reset_code"] as const) {
      const bn = renderCognitoMessage(kind, "bn", { code: "{####}" });
      const en = renderCognitoMessage(kind, "en", { code: "{####}" });
      expect(bn).toEqual(en);
      expect(bn.html).not.toMatch(BENGALI);
      expect(bn.subject).not.toMatch(BENGALI);
    }
  });

  it("with the rule off the Bengali templates still exist and render", () => {
    setNotifyEnglishOnly(false);
    try {
      const id = TEMPLATE_IDS[0] as (typeof TEMPLATE_IDS)[number];
      const data = parseTemplateData(id, SAMPLES[id].data);
      expect(renderEmail(id, data, ctx("bn")).subject).toMatch(BENGALI);
    } finally {
      setNotifyEnglishOnly(true);
    }
  });
});
