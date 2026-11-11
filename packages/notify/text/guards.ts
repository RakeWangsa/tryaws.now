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
  [
    "secret_word",
    /\b(?:password|passwd|passcode|secret|api[_ -]?key|token|bearer)\b\s*[:=]?\s*\S/i,
  ],
  ["long_hex", /\b[0-9a-f]{32,}\b/i],
  ["long_token", /[A-Za-z0-9+/_-]{40,}/],
  // +880 1712 345678, 01712345678: a full mobile number of Bangladesh
  ["phone_number", /(?:\+?880|\b0)[\s-]?1[3-9](?:[\s-]?\d){8}/],
  // a document number: a long run of digits (invoice numbers have hyphens between short groups)
  ["long_digits", /\d{12,}/],
  ["email_address", /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/],
];

export function scanSecrets(text: string): string | null {
  const t = latin(text);
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
