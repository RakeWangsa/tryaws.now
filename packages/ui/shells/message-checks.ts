import type { Messages } from "../runtime/index.ts";

/** Sorted dotted paths of the string leaves of a message tree. */
export function messageKeys(messages: Messages): string[] {
  const keys: string[] = [];
  const walk = (node: Messages, prefix: string): void => {
    for (const [name, value] of Object.entries(node)) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      if (typeof value === "string") keys.push(path);
      else walk(value, path);
    }
  };
  walk(messages, "");
  return keys.sort();
}

/** Keys that `a` has and `b` lacks. */
export function missingKeys(a: Messages, b: Messages): string[] {
  const inB = new Set(messageKeys(b));
  return messageKeys(a).filter((key) => !inB.has(key));
}

// Wording rules of 16.13 and R11/R14: the marks stand alone and no internal detail leaks.
const FORBIDDEN: readonly { rule: string; pattern: RegExp }[] = [
  { rule: "aws-lightsail", pattern: /\bAWS[\s -]*Lightsail/i },
  { rule: "powered-by-aws", pattern: /powered\s+by\s+aws/i },
  { rule: "joined-mark", pattern: /\b(?:AWS|Amazon)(?:Lightsail|Route53)\b/i },
  { rule: "arn", pattern: /arn:aws:/i },
  { rule: "account-id", pattern: /\b\d{12}\b/ },
  { rule: "internal-name", pattern: /\btc-[a-z]+-[a-z0-9]{4,}\b/i },
];

/** Every leaf string that breaks a rule, with the key and the name of the rule. */
export function forbiddenWording(messages: Messages): { key: string; rule: string }[] {
  const found: { key: string; rule: string }[] = [];
  const walk = (node: Messages, prefix: string): void => {
    for (const [name, value] of Object.entries(node)) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      if (typeof value === "string") {
        for (const { rule, pattern } of FORBIDDEN) {
          if (pattern.test(value)) found.push({ key: path, rule });
        }
      } else {
        walk(value, path);
      }
    }
  };
  walk(messages, "");
  return found;
}
