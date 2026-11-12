import { describe, expect, it } from "vitest";
import {
  BENGALI_DIGIT_FONT,
  BENGALI_DIGIT_ONE,
  DIGIT_ONE_CLASS,
  splitDigitOne,
  wrapDigitOneHtml,
} from "./digit-one";
import { escapeHtml } from "./render";

const SPAN = `<span class="${DIGIT_ONE_CLASS}">${BENGALI_DIGIT_ONE}</span>`;

describe("the Bengali digit one is a single named character and a single named font", () => {
  it("is U+09E7 and the font is Noto Sans Bengali (owner decision, one constant to change it)", () => {
    expect(BENGALI_DIGIT_ONE).toBe("১");
    expect(BENGALI_DIGIT_FONT).toBe("Noto Sans Bengali");
    expect(DIGIT_ONE_CLASS).toBe("d1");
  });
});

describe("splitDigitOne", () => {
  it("marks every U+09E7 and only U+09E7, also inside a number like ১২১", () => {
    expect(splitDigitOne("১২১")).toEqual([
      { text: "১", digitOne: true },
      { text: "২", digitOne: false },
      { text: "১", digitOne: true },
    ]);
    expect(splitDigitOne("a১b")).toEqual([
      { text: "a", digitOne: false },
      { text: "১", digitOne: true },
      { text: "b", digitOne: false },
    ]);
  });
  it("never touches the Latin 1 or the other Bengali digits and keeps text that has no ১ whole", () => {
    expect(splitDigitOne("1 ০২৩৪৫৬৭৮৯ abc")).toEqual([
      { text: "1 ০২৩৪৫৬৭৮৯ abc", digitOne: false },
    ]);
    expect(splitDigitOne("")).toEqual([]);
  });
  it("loses nothing: the pieces joined are the input", () => {
    const text = "৳ ১,২১১.১০ ১১ 1 ১";
    expect(
      splitDigitOne(text)
        .map((s) => s.text)
        .join(""),
    ).toBe(text);
  });
});

describe("wrapDigitOneHtml", () => {
  it("wraps each ১, also in a run like ১২১, and only in text", () => {
    expect(wrapDigitOneHtml("<p>১২১</p>")).toBe(`<p>${SPAN}২${SPAN}</p>`);
    expect(wrapDigitOneHtml("<p>1 ২ ৯</p>")).toBe("<p>1 ২ ৯</p>");
  });
  it("is idempotent", () => {
    const once = wrapDigitOneHtml("<div>১ ১১ x</div>");
    expect(wrapDigitOneHtml(once)).toBe(once);
  });
  it("wraps after escaping: a '<১>' input gives the escaped brackets and a wrapped digit", () => {
    const html = `<p>${escapeHtml("<১>")}</p>`;
    expect(wrapDigitOneHtml(html)).toBe(`<p>&lt;${SPAN}&gt;</p>`);
  });
  it("wraps a ১ of an address, with a quote and an ampersand around it", () => {
    const html = `<div>${escapeHtml('১ "Road" & ১১')}</div>`;
    expect(wrapDigitOneHtml(html)).toBe(`<div>${SPAN} &quot;Road&quot; &amp; ${SPAN}${SPAN}</div>`);
  });
  it("leaves the style block, the title and the attributes alone", () => {
    const html = `<html lang="bn"><head><title>১</title><style>.x{content:"১"}</style></head><body><p title="১">১</p></body></html>`;
    expect(wrapDigitOneHtml(html)).toBe(
      `<html lang="bn"><head><title>১</title><style>.x{content:"১"}</style></head><body><p title="১">${SPAN}</p></body></html>`,
    );
  });
});
