// The last check before a message leaves (R14, 16.14: no password, key, phone OTP or document number
// is sent). It returns the name of the rule that matched and never the text, so a refusal can be
// logged without the value.

const BENGALI_TO_LATIN: Record<string, string> = {
  "০": "0",
  "১": "1",
  "২": "2",
  "৩": "3",
  "৪": "4",
  "৫": "5",
  "৬": "6",
  "৭": "7",
  "৮": "8",
  "৯": "9",
};
const latin = (s: string): string => s.replace(/[০-৯]/g, (d) => BENGALI_TO_LATIN[d] as string);

const RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*-----/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  // A secret word that is given a value ("password: x", "token=x", "password is x"), or a bearer
  // header. Prose that only names the word ("change your password now") is not a secret.
  [
    "secret_word",
    /\b(?:password|passwd|passcode|secret|api[_ -]?key|token)\b\s*(?:[:=]|\bis\b)\s*\S|\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  ],
  ["long_hex", /\b[0-9a-f]{32,}\b/i],
  // Two classes, so that a panel link (slashes between short path segments) does not match: a
  // base64 run with slashes, and a url-safe run with hyphens. A UUID is 36 characters.
  ["long_token", /[A-Za-z0-9+/]{40,}|[A-Za-z0-9_-]{40,}/],
  // +880 1712 345678, 01712345678: a full mobile number of Bangladesh
  ["phone_number", /(?:\+?880|\b0)[\s-]?1[3-9](?:[\s-]?\d){8}/],
  // a document number: a long run of digits (invoice numbers have hyphens between short groups)
  ["long_digits", /\d{12,}/],
  ["email_address", /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/],
];

// WPU-Z5: the id of a support request in the panel path of a reply notice (/support/requests/<uuid>) is the
// id of a row, never a secret, but a random id has an all-digit last group about once in 280, which reads
// as a document number. Only that id, in that path, and only when no token character follows it, is set
// aside: `prefix_<uuid>`, `<uuid>@domain`, `<uuid>0` and a UUID anywhere else are checked as before, so a
// token glued to an id is never split.
const SUPPORT_REQUEST_PATH_ID =
  /\/support\/requests\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_+/@.-])/gi;

export function scanSecrets(text: string): string | null {
  const t = latin(text).replace(SUPPORT_REQUEST_PATH_ID, "/support/requests/id");
  for (const [name, re] of RULES) if (re.test(t)) return name;
  return null;
}

export interface SmsLength {
  readonly encoding: "gsm7" | "ucs2";
  readonly chars: number;
  readonly segments: number;
}

// GSM-7 here means printable ASCII (a safe subset of the GSM 03.38 alphabet); every other character
// makes the message UCS-2. One segment holds 160 or 70 characters, 153 or 67 when concatenated.
export function smsLength(text: string): SmsLength {
  const chars = [...text].length;
  const gsm7 = /^[\x20-\x7e\n]*$/.test(text);
  const [single, multi] = gsm7 ? [160, 153] : [70, 67];
  const segments = chars <= single ? 1 : Math.ceil(chars / multi);
  return { encoding: gsm7 ? "gsm7" : "ucs2", chars, segments };
}
