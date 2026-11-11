import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { bucketBn } from "./bucket-bn.ts";
import { bucketEn } from "./bucket-en.ts";
import { containerBn } from "./container-bn.ts";
import { containerEn } from "./container-en.ts";

const SETS = [
  { name: "Storage", bn: bucketBn, en: bucketEn, aws: "Amazon Lightsail object storage bucket" },
  {
    name: "Containers",
    bn: containerBn,
    en: containerEn,
    aws: "Amazon Lightsail container service",
  },
] as const;

const ACTION_ERRORS = [
  "unauthenticated",
  "fresh_sign_in_required",
  "flag_off",
  "validation",
  "rate_limited",
  "not_found",
  "name_mismatch",
  "confirm_required",
  "not_allowed",
  "unavailable",
];

describe("bucket and container screen messages (WP6-T4s)", () => {
  for (const set of SETS) {
    describe(set.name, () => {
      it("bn and en have the same keys, none empty, and no forbidden wording", () => {
        expect(messageKeys(set.bn)).toEqual(messageKeys(set.en));
        expect(messageKeys(set.bn).length).toBeGreaterThan(80);
        for (const tree of [set.bn, set.en]) {
          expect(forbiddenWording(tree)).toEqual([]);
          for (const key of messageKeys(tree)) {
            const value = key
              .split(".")
              .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
            expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
          }
        }
      });

      it("is composed in both locales in its own namespace, with bn text in bn", () => {
        for (const locale of ["bn", "en"] as const) {
          expect(webMessages[locale][set.name], locale).toBeDefined();
        }
        expect((webMessages.bn[set.name] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
      });

      it("names Amazon Lightsail the exact way and shows no account id or ARN (U6, 16.13)", () => {
        for (const tree of [set.bn, set.en]) {
          const text = JSON.stringify(tree);
          expect(text).toContain(set.aws);
          expect(text).not.toMatch(/arn:aws|\b\d{12}\b|AWS Lightsail/);
        }
      });

      it("every action error key of the cores has a text (U6)", () => {
        const errors = (set.en as Record<string, { error: Record<string, string> }>)[set.name]
          ?.error;
        for (const key of ACTION_ERRORS) expect(errors, key).toHaveProperty(key);
      });
    });
  }

  it("the secret key warning says once and 60 seconds, in both locales (U9)", () => {
    expect(bucketEn.Storage.detail.keys.warning).toMatch(/only once/);
    expect(bucketEn.Storage.detail.keys.warning).toMatch(/60 seconds/);
    expect(bucketBn.Storage.detail.keys.warning).toMatch(/একবার/);
    expect(bucketBn.Storage.detail.keys.warning).toContain("৬০");
  });

  it("the container text says that no registry login is given and only names of variables are shown", () => {
    expect(containerEn.Containers.detail.deploy.publicOnly).toMatch(/No login is given/);
    expect(containerEn.Containers.detail.deployments.variablesNote).toMatch(/only the names/);
  });
});
