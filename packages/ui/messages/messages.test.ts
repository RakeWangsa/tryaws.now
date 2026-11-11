import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findForbidden, flatten } from "./forbidden";

const here = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Bengali values that may have no Bengali letter (the word "English"). */
const ALLOW_LATIN_ONLY = ["kit.locale.en"];

const jsonFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const groups = (locale: "bn" | "en") => {
  const dir = join(here, locale);
  return Object.fromEntries(jsonFiles(dir).map((file) => [file, readJson(join(dir, file))]));
};
const bn = groups("bn");
const en = groups("en");
const placeholders = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string))].sort();

/** Every `.json` file below `dir`, whatever the depth. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return name.endsWith(".json") ? [path] : [];
  });
}

describe("message files of the kit", () => {
  it("each locale folder holds the same group files", () => {
    expect(jsonFiles(join(here, "bn"))).toEqual(jsonFiles(join(here, "en")));
  });

  it("every key exists in both locales", () => {
    for (const file of Object.keys(bn)) {
      const bnKeys = Object.keys(flatten(bn[file])).sort();
      const enKeys = Object.keys(flatten(en[file])).sort();
      const missingInEn = bnKeys.filter((k) => !enKeys.includes(k));
      const missingInBn = enKeys.filter((k) => !bnKeys.includes(k));
      expect(missingInEn, `${file}: keys missing in en`).toEqual([]);
      expect(missingInBn, `${file}: keys missing in bn`).toEqual([]);
    }
  });

  it("placeholders match", () => {
    for (const file of Object.keys(bn)) {
      const bnFlat = flatten(bn[file]);
      const enFlat = flatten(en[file]);
      for (const key of Object.keys(bnFlat)) {
        expect(placeholders(bnFlat[key] as string), `${file}: ${key}`).toEqual(
          placeholders(enFlat[key] as string),
        );
      }
    }
  });

  it("no empty value", () => {
    for (const [locale, all] of [
      ["bn", bn],
      ["en", en],
    ] as const) {
      for (const [file, tree] of Object.entries(all)) {
        for (const [key, value] of Object.entries(flatten(tree))) {
          expect(value.trim(), `${locale}/${file}: ${key}`).not.toBe("");
        }
      }
    }
  });

  it("Bengali first: every bn value has a Bengali letter unless it is allowed", () => {
    for (const [file, tree] of Object.entries(bn)) {
      for (const [key, value] of Object.entries(flatten(tree))) {
        if (ALLOW_LATIN_ONLY.includes(key)) continue;
        expect(/[\u0980-\u09FF]/.test(value), `bn/${file}: ${key} = ${JSON.stringify(value)}`).toBe(
          true,
        );
      }
    }
  });

  it("holds the kit.common group", () => {
    expect(flatten(en["common.json"])).toMatchObject({
      "kit.common.close": "Close",
      "kit.common.cancel": "Cancel",
      "kit.common.loading": "Loading",
    });
    expect(flatten(bn["common.json"])).toMatchObject({
      "kit.common.close": "বন্ধ করুন",
      "kit.common.cancel": "বাতিল",
      "kit.common.loading": "লোড হচ্ছে",
    });
  });
});

describe("forbidden forms (16.16)", () => {
  const files = [
    ...["bn", "en"].flatMap((locale) =>
      jsonFiles(join(here, locale)).map((file) => join(here, locale, file)),
    ),
    ...(existsSync(join(repoRoot, "apps"))
      ? readdirSync(join(repoRoot, "apps")).flatMap((app) => {
          const dir = join(repoRoot, "apps", app, "messages");
          return existsSync(dir) ? walk(dir) : [];
        })
      : []),
  ];

  it("finds the message files to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("no message value of the kit or of an app holds a forbidden form", () => {
    for (const path of files) {
      for (const [key, value] of Object.entries(flatten(readJson(path)))) {
        expect(findForbidden(value), `${path}: ${key} = ${JSON.stringify(value)}`).toEqual([]);
      }
    }
  });
});

describe("findForbidden", () => {
  it.each([
    "AWS Lightsail",
    "Lightsail instance",
    "AWS-Lightsail",
    "AWSLightsail",
    "Amazon-Lightsail",
    "AmazonLightsail",
    "AWS Route 53",
    "Route53",
    "Amazon Route53",
    "Powered by AWS",
    "arn:aws:iam::123",
    "account 123456789012",
    "tc-vps-0001",
  ])("refuses %j", (text) => {
    expect(findForbidden(text).length).toBeGreaterThan(0);
  });

  it.each([
    "Amazon Lightsail",
    "Amazon Route 53",
    "100% AWS infrastructure. Built on Amazon Lightsail.",
    "১০০% AWS অবকাঠামো। Amazon Lightsail দিয়ে তৈরি।",
  ])("accepts %j", (text) => {
    expect(findForbidden(text)).toEqual([]);
  });

  it("names the rules", () => {
    expect(findForbidden("AWS Lightsail")).toContain("aws-lightsail");
    expect(findForbidden("Lightsail instance")).toEqual(["bare-lightsail"]);
    expect(findForbidden("AmazonLightsail")).toContain("joined-amazon-lightsail");
    expect(findForbidden("Route53")).toEqual(["route53"]);
    expect(findForbidden("Powered by AWS")).toEqual(["powered-by-aws"]);
    expect(findForbidden("arn:aws:iam::123")).toEqual(["arn"]);
    expect(findForbidden("account 123456789012")).toEqual(["account-id"]);
    expect(findForbidden("tc-vps-0001")).toEqual(["internal-name"]);
  });

  it("checks a text that holds a correct and a wrong form", () => {
    expect(findForbidden("Amazon Route 53 and Route53")).toEqual(["route53"]);
  });
});

describe("flatten", () => {
  it("joins nested keys with a dot", () => {
    expect(flatten({ kit: { common: { close: "x" } }, top: "y" })).toEqual({
      "kit.common.close": "x",
      top: "y",
    });
  });

  it("uses the prefix", () => {
    expect(flatten({ a: "x" }, "p")).toEqual({ "p.a": "x" });
  });

  it("refuses a value that is not a string or an object", () => {
    expect(() => flatten({ a: 1 })).toThrow(TypeError);
    expect(() => flatten({ a: ["x"] })).toThrow(TypeError);
    expect(() => flatten(null)).toThrow(TypeError);
  });
});
