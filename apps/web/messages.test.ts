import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "./i18n/messages.ts";
import { AUTH_ERROR_CODES, FIELD_CODES } from "./server/auth/state.ts";
import { authBn } from "./messages/auth-bn.ts";
import { authEn } from "./messages/auth-en.ts";
import { bn } from "./messages/bn.ts";
import { en } from "./messages/en.ts";
import { walletBn } from "./messages/wallet-bn.ts";
import { walletEn } from "./messages/wallet-en.ts";

describe("Wallet messages (WP3-T4)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(walletBn)).toEqual(messageKeys(walletEn));
    expect(messageKeys(walletBn).length).toBeGreaterThan(40);
    for (const tree of [walletBn, walletEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      const flat = messageKeys(tree);
      for (const key of flat) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("is composed next to Web, Shell and kit in both locales, and bn is composed first", () => {
    for (const locale of ["bn", "en"] as const) {
      const messages = webMessages[locale];
      expect(messages["Wallet"], locale).toBeDefined();
      expect(messages["Web"], locale).toBeDefined();
      expect(messages["Shell"], locale).toBeDefined();
      expect(messages["kit"], locale).toBeDefined();
    }
    const heading = (webMessages.bn["Wallet"] as Messages)["heading"];
    expect(heading).toBe(walletBn.Wallet.heading);
    expect(heading).toMatch(/[ঀ-৿]/);
  });
});

describe("Auth messages (WP2-T2)", () => {
  const flat = (tree: Messages, key: string): unknown =>
    key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);

  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(authBn)).toEqual(messageKeys(authEn));
    expect(messageKeys(authBn).length).toBeGreaterThan(80);
    for (const tree of [authBn, authEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = flat(tree, key);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("has a message for every AuthErrorCode and every FieldCode", () => {
    for (const tree of [authBn, authEn]) {
      const keys = new Set(messageKeys(tree));
      for (const code of AUTH_ERROR_CODES) expect(keys.has(`Auth.error.${code}`), code).toBe(true);
      for (const code of FIELD_CODES) expect(keys.has(`Auth.field.error.${code}`), code).toBe(true);
    }
  });

  it("writes Bengali first: every bn value has Bengali letters (except a lone placeholder)", () => {
    for (const key of messageKeys(authBn)) {
      expect(String(flat(authBn, key)), key).toMatch(/[ঀ-৿]/);
    }
    for (const key of messageKeys(authEn)) {
      expect(String(flat(authEn, key)), key).not.toMatch(/[ঀ-৿]/);
    }
  });

  it("uses the same ICU placeholders in bn and en", () => {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of messageKeys(authBn)) {
      expect(names(String(flat(authBn, key))), key).toEqual(names(String(flat(authEn, key))));
    }
  });

  it("is composed next to Web, Wallet, Shell and kit in both locales", () => {
    for (const locale of ["bn", "en"] as const) {
      const messages = webMessages[locale];
      expect(messages["Auth"], locale).toBeDefined();
      expect(messages["Wallet"], locale).toBeDefined();
      expect(messages["Web"], locale).toBeDefined();
    }
    const login = ((webMessages.bn["Auth"] as Messages)["login"] as Messages)["heading"];
    expect(login).toBe(authBn.Auth.login.heading);
  });
});

describe("Web messages", () => {
  it("bn and en of Web have the same keys", () => {
    expect(messageKeys(bn)).toEqual(messageKeys(en));
    expect(messageKeys(bn)).toEqual([
      "Web.announcement",
      "Web.home.title",
      "Web.meta.description",
      "Web.meta.title",
    ]);
  });

  it("holds no forbidden wording", () => {
    expect(forbiddenWording(bn)).toEqual([]);
    expect(forbiddenWording(en)).toEqual([]);
  });

  it("webMessages has the Shell and Web namespaces for bn and en, without a collision", () => {
    for (const locale of ["bn", "en"] as const) {
      const messages = webMessages[locale];
      expect(messages["Shell"], locale).toBeDefined();
      expect(messages["Web"], locale).toBeDefined();
      expect(messages["Aws"], locale).toBeDefined();
    }
  });

  it("Web.meta.description embeds Aws.short as written", () => {
    for (const locale of ["bn", "en"] as const) {
      const messages = webMessages[locale];
      const aws = messages["Aws"] as Messages;
      const web = messages["Web"] as Messages;
      const meta = web["meta"] as Messages;
      expect(meta["description"], locale).toContain(aws["short"] as string);
    }
  });
});
