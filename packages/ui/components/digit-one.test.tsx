// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DIGIT_ONE_CLASS, splitDigitOne, wrapDigitOne } from "./digit-one";

const html = (text: string): string =>
  renderToStaticMarkup(<p>{wrapDigitOne(text)}</p>).replace(/^<p>|<\/p>$/g, "");
const SPAN = `<span class="${DIGIT_ONE_CLASS}">১</span>`;

describe("wrapDigitOne (WPU-F1)", () => {
  it("wraps every ১, also inside ১২১, and only ১", () => {
    expect(html("১২১")).toBe(`${SPAN}২${SPAN}`);
    expect(html("৳ ১,০০০.১০")).toBe(`৳ ${SPAN},০০০.${SPAN}০`);
  });

  it("never touches the Latin 1 or the other Bengali digits", () => {
    expect(html("1 ০ ২ ৩ ৪ ৫ ৬ ৭ ৮ ৯")).toBe("1 ০ ২ ৩ ৪ ৫ ৬ ৭ ৮ ৯");
    expect(html("")).toBe("");
  });

  it("has no inline style attribute (U4) and uses the class of tc.css", () => {
    expect(DIGIT_ONE_CLASS).toBe("tc-d1");
    expect(html("১")).not.toMatch(/style=/);
  });

  it("escapes safely: React escapes the text, so '<১>' is text around a span", () => {
    expect(html("<১>")).toBe(`&lt;${SPAN}&gt;`);
    expect(html('"১" & ১')).toBe(`&quot;${SPAN}&quot; &amp; ${SPAN}`);
  });

  it("is idempotent on text: the pieces joined are the input, and a second split gives the same pieces", () => {
    const text = "১২১ x ১";
    const once = splitDigitOne(text);
    expect(once.map((p) => p.text).join("")).toBe(text);
    expect(splitDigitOne(once.map((p) => p.text).join(""))).toEqual(once);
  });

  it("returns a text without ১ as one string", () => {
    expect(wrapDigitOne("abc ২৩")).toEqual(["abc ২৩"]);
  });
});
