import type { Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import { PUBLIC_MARKET } from "./catalog.ts";
import { HOME_REGIONS } from "../../app/[locale]/(public)/home/home-data.ts";
import { PUBLIC_IMAGE_REGIONS, loadPublicImages, type ImagesDeps } from "./images.ts";

// WPU-X22 item 4: the public, read-only list of the offered images. It follows the allow-list the
// panel reads, is behind the family flag (R12) and hides itself when anything cannot be read (R16).

const TX = {} as Tx;
const spec = (name: string, kind: "app" | "os", version: string | null = null) => ({
  name,
  kind,
  group: null,
  version,
  loginUser: "ubuntu",
  minPower: 500,
});
const ROWS: Record<string, { awsId: string; specs: unknown }[]> = {
  "ap-southeast-1": [
    { awsId: "wordpress_ls_1_0", specs: spec("WordPress", "app", "6.8") },
    { awsId: "ubuntu_24_04", specs: spec("Ubuntu", "os", "24.04 LTS") },
    { awsId: "debian_12", specs: spec("Debian", "os", "12") },
    { awsId: "freebsd_14", specs: spec("FreeBSD", "os", "14") }, // not on the default list
    { awsId: "broken", specs: { kind: "nope" } }, // specs the sync would never write
  ],
  "ap-south-1": [{ awsId: "ubuntu_24_04", specs: spec("Ubuntu", "os", "24.04 LTS") }],
};

function deps(over: Partial<ImagesDeps> = {}): ImagesDeps {
  return {
    run: (fn) => fn(TX),
    flags: async () => [{ key: "linux_instance", enabled: true }],
    switches: async () => ({ state: "none" }),
    active: async (_tx, region) => ROWS[region] ?? [],
    ...over,
  };
}

describe("loadPublicImages (WPU-X22)", () => {
  it("offers the images of the allow-list per location, sorted by name, with name, version and kind only", async () => {
    const out = await loadPublicImages(PUBLIC_IMAGE_REGIONS, deps());
    expect(out.state).toBe("ok");
    if (out.state !== "ok") return;
    expect(out.byRegion["ap-southeast-1"]).toEqual([
      { id: "debian_12", name: "Debian", version: "12", kind: "os" },
      { id: "ubuntu_24_04", name: "Ubuntu", version: "24.04 LTS", kind: "os" },
      { id: "wordpress_ls_1_0", name: "WordPress", version: "6.8", kind: "app" },
    ]);
    expect(out.byRegion["ap-south-1"]?.map((i) => i.id)).toEqual(["ubuntu_24_04"]);
    // nothing but what a visitor may see
    expect(JSON.stringify(out)).not.toMatch(/loginUser|minPower|ubuntu"\s*,\s*"loginUser/);
  });

  it("follows the admin's switches: an image switched on appears, one switched off does not", async () => {
    const out = await loadPublicImages(
      ["ap-southeast-1"],
      deps({
        switches: async () => ({
          state: "ok",
          switches: { on: ["freebsd_14"], off: ["debian_12"] },
        }),
      }),
    );
    expect(out.state === "ok" && out.byRegion["ap-southeast-1"]?.map((i) => i.id)).toEqual([
      "freebsd_14",
      "ubuntu_24_04",
      "wordpress_ls_1_0",
    ]);
  });

  it("reads the flag and the market of the public site", async () => {
    const seen: string[] = [];
    await loadPublicImages(
      ["ap-southeast-1"],
      deps({
        flags: async (_tx, market) => {
          seen.push(market);
          return [{ key: "linux_instance", enabled: true }];
        },
        switches: async (_tx, market) => {
          seen.push(market);
          return { state: "none" };
        },
      }),
    );
    expect(seen).toEqual([PUBLIC_MARKET, PUBLIC_MARKET]);
  });

  it("is unavailable when the family flag is off or missing (R12)", async () => {
    for (const flags of [[], [{ key: "linux_instance", enabled: false }]]) {
      const out = await loadPublicImages(["ap-southeast-1"], deps({ flags: async () => flags }));
      expect(out).toEqual({ state: "unavailable" });
    }
  });

  it("is unavailable when the stored allow-list does not parse (R16)", async () => {
    const out = await loadPublicImages(
      ["ap-southeast-1"],
      deps({ switches: async () => ({ state: "invalid" }) }),
    );
    expect(out).toEqual({ state: "unavailable" });
  });

  it("is unavailable when any read throws, without leaking the error (R16, R14)", async () => {
    const out = await loadPublicImages(
      ["ap-southeast-1"],
      deps({
        active: async () => {
          throw new Error("password=secret host=db.internal");
        },
      }),
    );
    expect(out).toEqual({ state: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("asks for the same two locations as the home chooser", () => {
    expect([...PUBLIC_IMAGE_REGIONS]).toEqual([...HOME_REGIONS]);
  });
});
