// The Bengali digit one (U+09E7) is drawn with a different font than the rest of the Bengali text (owner
// decision, WPU-F1): Hind Siliguri for the text, Noto Sans Bengali for this one digit. The font name is
// this one constant. On the web a unicode-range face does the job without markup (packages/ui/styles/tc.css);
// the PDF engine and the emails cannot use a @font-face URL, so they wrap the digit in a span instead.
// Pure: no I/O, the same input gives the same text.

/** U+09E7 BENGALI DIGIT ONE. */
export const BENGALI_DIGIT_ONE = "১";

/** The font of the digit one: the single place to change it. A fontconfig name, packaged with the function. */
export const BENGALI_DIGIT_FONT = "Noto Sans Bengali";

/** The class of the wrapping span (a rule of the template's <style> block, never an inline style: U4). */
export const DIGIT_ONE_CLASS = "d1";

export interface DigitPiece {
  readonly text: string;
  readonly digitOne: boolean;
}

/** Cuts plain text into pieces: every U+09E7 alone, the text between them whole. */
export function splitDigitOne(text: string): DigitPiece[] {
  const pieces: DigitPiece[] = [];
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

/** The reverse of the wrapping, for tests and for plain-text use of a finished document. */
export function unwrapDigitOneHtml(html: string): string {
  return html.replaceAll(
    `<span class="${DIGIT_ONE_CLASS}">${BENGALI_DIGIT_ONE}</span>`,
    BENGALI_DIGIT_ONE,
  );
}

const TAG_SPLIT = /(<[^>]*>)/;
const OPEN_D1 = new RegExp(`^<span\\s+class="${DIGIT_ONE_CLASS}"\\s*>$`, "i");
const OPEN_RAW_TEXT = /^<(style|title)\b/i;
const CLOSE_RAW_TEXT = /^<\/(style|title)\b/i;

/**
 * Wraps every U+09E7 of the TEXT of an HTML document in `<span class="d1">`. The caller escapes first and
 * wraps after: this function never escapes, it only looks for tags it can see, and escaped text holds no
 * "<". Text inside <style> and <title> is raw text, where a span would show as characters, and
 * attributes are not text: both stay as they are. A digit that is already wrapped is not wrapped again.
 */
export function wrapDigitOneHtml(html: string): string {
  let raw = false;
  let wrapped = false;
  return html
    .split(TAG_SPLIT)
    .map((part, index) => {
      if (index % 2 === 1) {
        if (OPEN_RAW_TEXT.test(part)) raw = true;
        else if (CLOSE_RAW_TEXT.test(part)) raw = false;
        else if (OPEN_D1.test(part)) wrapped = true;
        else if (/^<\/span\s*>$/i.test(part)) wrapped = false;
        return part;
      }
      if (raw || wrapped || !part.includes(BENGALI_DIGIT_ONE)) return part;
      return splitDigitOne(part)
        .map((piece) =>
          piece.digitOne
            ? `<span class="${DIGIT_ONE_CLASS}">${BENGALI_DIGIT_ONE}</span>`
            : piece.text,
        )
        .join("");
    })
    .join("");
}
