import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENABLED_BLUEPRINTS,
  EMPTY_ALLOW_LIST,
  groupBlueprints,
  imageLogoOf,
  isBlueprintId,
  isImageOn,
  mapBlueprint,
  offeredImages,
  optionOf,
  type BlueprintOption,
} from "./blueprints";
import { loginUserOf } from "./connect";
import { parseInstanceConfig } from "./instance";

const REGION = "ap-southeast-1";
const raw = (over: Record<string, unknown> = {}) => ({
  blueprintId: "ubuntu_24_04",
  name: "Ubuntu",
  type: "os",
  group: "ubuntu",
  version: "24.04 LTS",
  platform: "LINUX_UNIX",
  isActive: true,
  ...over,
});

describe("mapBlueprint", () => {
  it("maps an OS image to a catalog row of the family blueprint with the login user of its id", () => {
    expect(mapBlueprint(raw(), REGION)).toEqual({
      family: "blueprint",
      awsId: "ubuntu_24_04",
      platform: "linux",
      region: REGION,
      specs: {
        name: "Ubuntu",
        kind: "os",
        group: "ubuntu",
        version: "24.04 LTS",
        loginUser: "ubuntu",
        minPower: null,
      },
      awsPriceUsd: "0",
      billingUnit: "none",
      featureFlag: "linux_instance",
      active: true,
    });
  });
  it("maps an app image to the Apps + OS kind and a bitnami user", () => {
    const m = mapBlueprint(
      raw({ blueprintId: "wordpress", type: "app", name: "WordPress" }),
      REGION,
    );
    expect(m?.specs.kind).toBe("app");
    expect(m?.specs.loginUser).toBe("bitnami");
  });
  it("maps a Lightsail-packaged app image to the admin user (WPU-Y1)", () => {
    const m = mapBlueprint(
      raw({ blueprintId: "wordpress_ls_1_0", type: "app", name: "WordPress" }),
      REGION,
    );
    expect(m?.specs.loginUser).toBe("admin");
  });
  it("refuses Windows, a bad id, an unknown type and a bad Region (fail closed)", () => {
    expect(mapBlueprint(raw({ platform: "WINDOWS" }), REGION)).toBeNull();
    expect(mapBlueprint(raw({ blueprintId: "Ubuntu 24" }), REGION)).toBeNull();
    expect(mapBlueprint(raw({ blueprintId: "x'; drop" }), REGION)).toBeNull();
    expect(mapBlueprint(raw({ type: "weird" }), REGION)).toBeNull();
    expect(mapBlueprint(null, REGION)).toBeNull();
    expect(mapBlueprint(raw(), "mars")).toBeNull();
  });
  it("an inactive image is kept but marked not active", () => {
    expect(mapBlueprint(raw({ isActive: false }), REGION)?.active).toBe(false);
  });
  it("cuts a long or control-character name", () => {
    const m = mapBlueprint(raw({ name: `A\u0000${"b".repeat(200)}` }), REGION);
    expect(m?.specs.name.length).toBeLessThanOrEqual(80);
    expect(m?.specs.name.includes("\u0000")).toBe(false);
  });
});

describe("login users", () => {
  it.each([
    ["ubuntu_24_04", "ubuntu"],
    ["amazon_linux_2023", "ec2-user"],
    ["debian_12", "admin"],
    ["lamp_8_bitnami", "bitnami"],
    ["ghost_bitnami", "bitnami"],
    ["nginx", "bitnami"],
  ])("%s logs in as %s", (id, user) => {
    expect(loginUserOf(id)).toBe(user);
  });
  it("WPU-Y1: the defaults are the Lightsail-packaged app images, not the Bitnami ones", () => {
    for (const id of ["wordpress_ls_1_0", "lamp_ls_1_0", "node_ls_1_0", "nginx_ls_1_0"]) {
      expect(DEFAULT_ENABLED_BLUEPRINTS, id).toContain(id);
      expect(isImageOn(EMPTY_ALLOW_LIST, id), id).toBe(true);
      expect(loginUserOf(id), id).toBe("admin");
    }
    for (const id of ["wordpress", "lamp_8_bitnami", "nodejs", "nginx"]) {
      expect(DEFAULT_ENABLED_BLUEPRINTS, id).not.toContain(id);
      expect(isImageOn(EMPTY_ALLOW_LIST, id), id).toBe(false);
    }
  });
  it("every default image has a known login user", () => {
    for (const id of DEFAULT_ENABLED_BLUEPRINTS) expect(loginUserOf(id)).not.toBeNull();
  });
});

describe("the allow-list", () => {
  it("an id in neither list follows the default; an explicit switch wins over the default", () => {
    expect(isImageOn(EMPTY_ALLOW_LIST, "ubuntu_24_04")).toBe(true);
    expect(isImageOn(EMPTY_ALLOW_LIST, "some_new_app")).toBe(false);
    expect(isImageOn({ on: ["some_new_app"], off: [] }, "some_new_app")).toBe(true);
    expect(isImageOn({ on: [], off: ["ubuntu_24_04"] }, "ubuntu_24_04")).toBe(false);
  });
  const row = (id: string, kind: string, name = id) => ({
    awsId: id,
    specs: { name, kind, group: null, version: null, loginUser: "x" },
  });
  it("offers only switched-on rows with valid specs", () => {
    const offered = offeredImages(
      [row("ubuntu_24_04", "os"), row("some_new_app", "app"), row("debian_12", "weird")],
      EMPTY_ALLOW_LIST,
    );
    expect(offered.map((o) => o.id)).toEqual(["ubuntu_24_04"]);
  });
  it("optionOf refuses specs that are not what the sync writes", () => {
    expect(optionOf({ awsId: "ubuntu_24_04", specs: null })).toBeNull();
    expect(optionOf({ awsId: "ubuntu_24_04", specs: [] })).toBeNull();
    expect(optionOf({ awsId: "Bad Id", specs: { kind: "os" } })).toBeNull();
  });
});

describe("imageLogoOf", () => {
  it.each([
    ["ubuntu_24_04", "ubuntu"],
    ["wordpress", "wordpress"],
    ["lamp_8_bitnami", "lamp"],
    ["lamp_ls_1_0", "lamp"],
    ["wordpress_ls_1_0", "wordpress"],
    ["debian_12", "debian"],
  ])("%s uses the %s logo", (id, logo) => {
    expect(imageLogoOf(id)).toBe(logo);
  });
  it("an image without a logo, or not an id, gets none (the generic icon)", () => {
    expect(imageLogoOf("amazon_linux_2023")).toBeNull();
    expect(imageLogoOf("../ubuntu")).toBeNull();
    expect(imageLogoOf(undefined)).toBeNull();
  });
  // The logos are files of the vendored Antler theme, which a public checkout does not have (docs/theme.md).
  const dir = fileURLToPath(new URL("../../ui/theme/assets/apps", import.meta.url));
  it.skipIf(!existsSync(dir))("every logo is a file of the theme", () => {
    const files = new Set(readdirSync(dir));
    for (const id of ["ubuntu", "debian", "wordpress", "lamp", "joomla", "plesk", "docker"]) {
      expect(files.has(`${imageLogoOf(id)}.svg`), id).toBe(true);
    }
  });
});

describe("groupBlueprints", () => {
  const opt = (id: string, kind: "app" | "os", name = id): BlueprintOption => ({
    id,
    kind,
    name,
    minPower: null,
    version: null,
    loginUser: "x",
  });
  it("splits Apps + OS from OS only and sorts by name", () => {
    const g = groupBlueprints([
      opt("b", "app", "Beta"),
      opt("a", "app", "Alpha"),
      opt("z", "os", "Zed"),
    ]);
    expect(g.apps.map((o) => o.id)).toEqual(["a", "b"]);
    expect(g.os.map((o) => o.id)).toEqual(["z"]);
  });
});

describe("isBlueprintId", () => {
  it("accepts lower-case words with digits and underscores only", () => {
    expect(isBlueprintId("lamp_8_bitnami")).toBe(true);
    expect(isBlueprintId("Ubuntu")).toBe(false);
    expect(isBlueprintId("")).toBe(false);
    expect(isBlueprintId("a".repeat(65))).toBe(false);
    expect(isBlueprintId(5)).toBe(false);
  });
});

describe("the order configuration carries the image", () => {
  const base = {
    productId: "0190a000-0000-7000-8000-000000000001",
    region: "ap-southeast-1",
    displayName: "web",
    keyPairId: "0190a000-0000-7000-8000-000000000002",
  };
  it("keeps a valid blueprintId", () => {
    const r = parseInstanceConfig({ ...base, blueprintId: "wordpress" });
    expect(r.ok && r.value.blueprintId).toBe("wordpress");
  });
  it("no blueprintId is allowed (older orders) and stays absent", () => {
    const r = parseInstanceConfig(base);
    expect(r.ok && "blueprintId" in r.value).toBe(false);
  });
  it("refuses a blueprintId that is not an id", () => {
    const r = parseInstanceConfig({ ...base, blueprintId: "Ubuntu 24.04; rm" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields).toEqual({ blueprintId: "invalid" });
  });
  it("a restore does not take an image", () => {
    const r = parseInstanceConfig({
      ...base,
      keyPairId: null,
      blueprintId: "wordpress",
      restoreFromBackupId: "0190a000-0000-7000-8000-000000000003",
    });
    expect(r.ok).toBe(false);
  });
});
