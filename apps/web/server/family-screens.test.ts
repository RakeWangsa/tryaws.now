import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { FAMILY_SCREENS, familyScreen } from "./family-screens.ts";

describe("family screens of the order flow", () => {
  it("knows the CDN, the bucket and the container service, and nothing else (a server is the default)", () => {
    expect(Object.keys(FAMILY_SCREENS).sort()).toEqual([
      "bucket",
      "cdn",
      "container_service",
      "database",
      "domain",
      "load_balancer",
    ]);
    expect(familyScreen("bucket")).toMatchObject({ base: "/storage", nav: "objectStorage" });
    expect(familyScreen("container_service")).toMatchObject({
      base: "/containers",
      nav: "containers",
    });
    expect(familyScreen("linux_instance")).toBeUndefined();
    expect(familyScreen(undefined)).toBeUndefined();
    // No prototype key slips through.
    expect(familyScreen("constructor")).toBeUndefined();
  });

  it("every row has the open-the-resource text in both locales", () => {
    for (const row of Object.values(FAMILY_SCREENS)) {
      for (const locale of ["bn", "en"] as const) {
        const tree = webMessages[locale][(row as NonNullable<typeof row>).ns] as {
          order: { open: string };
        };
        expect(tree.order.open.length).toBeGreaterThan(0);
      }
    }
  });
});
