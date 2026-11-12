import { createElement, type ReactNode } from "react";

// The Bengali digit one (U+09E7) has its own font (owner decision, WPU-F1). On the web a unicode-range face in
// packages/ui/styles/tc.css draws it without any markup, and that is the way to use. This helper is for a place
// where a CSS face cannot do the job: it returns the text with every U+09E7 in <span class="tc-d1">, and the
// class carries no inline style (U4). It is pure: the same text gives the same nodes. React escapes the text,
// so nothing here is markup.

/** U+09E7 BENGALI DIGIT ONE. */
export const BENGALI_DIGIT_ONE = "১";

/** The class of the span: a rule of tc.css (font-family "TC Bengali One"). */
export const DIGIT_ONE_CLASS = "tc-d1";

/** Cuts text into pieces: every U+09E7 alone, the text between them whole. Latin digits are never touched. */
export function splitDigitOne(text: string): { text: string; digitOne: boolean }[] {
  const pieces: { text: string; digitOne: boolean }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== BENGALI_DIGIT_ONE) continue;
    if (i > start) pieces.push({ text: text.slice(start, i), digitOne: false });
    pieces.push({ text: BENGALI_DIGIT_ONE, digitOne: true });
    start = i + 1;
  }
  if (start < text.length) pieces.push({ text: text.slice(start), digitOne: false });
  return pieces;
}

/** The text as React nodes: plain strings, and a span for each U+09E7. Text without one is returned whole. */
export function wrapDigitOne(text: string): ReactNode[] {
  return splitDigitOne(text).map((piece, index) =>
    piece.digitOne
      ? createElement("span", { key: index, className: DIGIT_ONE_CLASS }, piece.text)
      : piece.text,
  );
}
