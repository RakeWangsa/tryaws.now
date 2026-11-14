import qrcode from "qrcode-generator";

// WPU-X11 (owner answer 2026-11-14 19:20, "ok do"): the QR code of the authenticator enrolment, made on
// the server from the otpauth URI with qrcode-generator 2.0.4 (MIT, no dependencies, pinned; the R17
// reason is in JOURNEY.md). The answer is path data for one inline SVG <path>, not markup: the page
// renders it with React (no dangerouslySetInnerHTML, no style attribute, no third-party origin, U3/U4).
// The URI holds the secret: it is never logged, and the path is returned only in the same Server Action
// answer as the secret (U9).

export interface QrPath {
  /** Modules per side, without the quiet zone. */
  readonly size: number;
  /** The quiet zone in modules on each side (4, as ISO/IEC 18004 asks). */
  readonly margin: number;
  /** One SVG path of 1x1 squares for the dark modules, in module units, offset by the margin. */
  readonly d: string;
}

export const QR_MARGIN = 4;

/** Error correction M: a phone reads it from a screen; the URI fits a small version. */
export function qrPathOf(text: string): QrPath {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) parts.push(`M${col + QR_MARGIN} ${row + QR_MARGIN}h1v1h-1z`);
    }
  }
  return { size, margin: QR_MARGIN, d: parts.join("") };
}
