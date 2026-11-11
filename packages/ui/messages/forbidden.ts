// Forbidden forms in message text (16.13 and 16.16). Write "AWS" and "Amazon Lightsail"; never
// "AWS Lightsail", and never abbreviate, join or hyphenate a mark. Internal names, account ids and
// ARNs are never shown (R11).

interface Rule {
  name: string;
  test: (text: string) => boolean;
}

const RULES: readonly Rule[] = [
  { name: "aws-lightsail", test: (t) => /\bAWS[\s-]*Lightsail/i.test(t) },
  // Lightsail is named only as "Amazon Lightsail".
  { name: "bare-lightsail", test: (t) => /(?<!Amazon )Lightsail/i.test(t) },
  { name: "joined-amazon-lightsail", test: (t) => /Amazon-?Lightsail/.test(t) },
  // Only the exact form "Amazon Route 53" is allowed.
  { name: "route53", test: (t) => /(?<!Amazon )Route\s?53|Route53/.test(t) },
  { name: "powered-by-aws", test: (t) => /powered by AWS/i.test(t) },
  { name: "arn", test: (t) => /arn:aws[\w-]*:/.test(t) },
  { name: "account-id", test: (t) => /\b\d{12}\b/.test(t) },
  { name: "internal-name", test: (t) => /\btc-[a-z0-9]+-[a-z0-9]+/.test(t) },
];

/** The names of the rules that `text` breaks; an empty array when the text is clean. */
export function findForbidden(text: string): string[] {
  return RULES.filter((rule) => rule.test(text)).map((rule) => rule.name);
}

/**
 * Flattens a message tree to `{ "a.b.c": "text" }`. A value that is neither a string nor a plain
 * object is a defect of the file, so it throws.
 */
export function flatten(tree: unknown, prefix = ""): Record<string, string> {
  if (typeof tree === "string") {
    if (prefix === "") throw new TypeError("flatten: the root of a message tree is a string");
    return { [prefix]: tree };
  }
  if (typeof tree !== "object" || tree === null || Array.isArray(tree)) {
    throw new TypeError(
      `flatten: ${prefix === "" ? "the root" : prefix} is not a string or an object`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    Object.assign(out, flatten(value, prefix === "" ? key : `${prefix}.${key}`));
  }
  return out;
}
