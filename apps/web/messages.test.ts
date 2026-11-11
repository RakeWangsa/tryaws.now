import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "./i18n/messages.ts";
import { bn } from "./messages/bn.ts";
import { en } from "./messages/en.ts";

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
