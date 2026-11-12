import type { Locale } from "@tc/core";
import { escapeHtml } from "../text/format";
import { SHARED } from "./messages";

// The layout of email/index.html rebuilt as a table-based mail with inline CSS only (U4): dark
// header with the wordmark, one headline band, white body, dark footer with the company address,
// the short AWS statement and the trademark line (16.14, 16.13). Colors of 16.4. Every text node
// and attribute is escaped here, once, at the last step; the strings before this are plain text.

const C = {
  page: "#15212a",
  card: "#101920",
  onDark: "#ffffff",
  muted: "#6c757d",
  text: "#212122",
  accent: "#ee5586",
  button: "#fdd700",
} as const;

export interface EmailParts {
  readonly locale: Locale;
  readonly subject: string;
  readonly headline: string;
  readonly paragraphs: readonly string[];
  readonly button?: { readonly label: string; readonly url: string };
}

// Links go only to the panel's own domain: the origin is configuration, the path is fixed by the
// template, and neither a query nor a fragment is ever added (16.14).
export function panelUrl(origin: string, locale: Locale, path: string): string {
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/i.test(origin)) {
    throw new TypeError("panelUrl: the origin must be https and have no path");
  }
  if (!/^\/[A-Za-z0-9._/-]*$/.test(path)) throw new TypeError("panelUrl: bad path");
  return `${origin}${locale === "en" ? "/en" : ""}${path}`;
}

export function layoutEmail(p: EmailParts): { html: string; text: string } {
  const sh = SHARED[p.locale];
  const bn = p.locale === "bn";
  const font = bn
    ? `'Noto Sans Bengali','Hind Siliguri',Arial,sans-serif`
    : `-apple-system,'Segoe UI',Arial,sans-serif`;
  // Bengali needs a taller line and no letter spacing (16.4).
  const base = `font-family:${font};line-height:${bn ? "1.7" : "1.5"};letter-spacing:0;`;
  const e = escapeHtml;
  const paragraphs = p.paragraphs
    .filter((x) => x.length > 0)
    .map(
      (x) =>
        `<p style="margin:0 0 14px 0;font-size:16px;color:${C.text};${base}">${e(x).replaceAll("\n", "<br>")}</p>`,
    )
    .join("");
  const button =
    p.button === undefined
      ? ""
      : `<p style="margin:22px 0 0 0;"><a href="${e(p.button.url)}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:${C.button};color:#000000;font-weight:bold;text-decoration:none;${base}">${e(p.button.label)}</a></p>`;
  const html =
    `<!doctype html><html lang="${p.locale}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${e(p.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${C.page};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;">` +
    `<tr><td style="background:${C.card};padding:20px 28px;color:${C.onDark};font-size:22px;font-weight:bold;${base}">${e(sh.wordmark)}</td></tr>` +
    `<tr><td style="background:${C.accent};padding:18px 28px;color:${C.onDark};font-size:20px;font-weight:bold;${base}">${e(p.headline)}</td></tr>` +
    `<tr><td style="background:#ffffff;padding:28px;">${paragraphs}${button}</td></tr>` +
    `<tr><td style="background:${C.card};padding:20px 28px;color:${C.muted};font-size:12px;${base}">` +
    `<p style="margin:0 0 8px 0;color:${C.onDark};">${e(sh.awsShort)}</p>` +
    `<p style="margin:0 0 8px 0;">${e(sh.footerNote)}</p>` +
    `<p style="margin:0 0 8px 0;">${e(sh.address)}</p>` +
    `<p style="margin:0;">${e(sh.trademark)}</p>` +
    `</td></tr></table></td></tr></table></body></html>`;
  const text = [
    p.headline,
    "",
    ...p.paragraphs.filter((x) => x.length > 0),
    ...(p.button === undefined ? [] : ["", `${p.button.label}: ${p.button.url}`]),
    "",
    "--",
    sh.awsShort,
    sh.footerNote,
    sh.address,
    sh.trademark,
  ].join("\n");
  return { html, text };
}
