import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLUEPRINT_ID,
  loginUserOf,
  parseServerDisplayName,
  sshCommandOf,
  isLightsailPackaged,
  appPasswordFileOf,
  storedLoginUserOf,
} from "./connect";

describe("loginUserOf", () => {
  it.each([
    ["ubuntu_24_04", "ubuntu"],
    ["ubuntu_22_04", "ubuntu"],
    ["amazon_linux_2023", "ec2-user"],
    ["debian_12", "admin"],
    ["almalinux_9_4", "ec2-user"],
    ["centos_stream_9", "ec2-user"],
    ["wordpress", "bitnami"],
    ["nodejs", "bitnami"],
    ["nginx", "bitnami"],
    ["lamp_8_bitnami", "bitnami"],
    // WPU-Y1: Lightsail-packaged images log in as admin (Lightsail SSH guide), not bitnami.
    ["wordpress_ls_1_0", "admin"],
    ["lamp_ls_1_0", "admin"],
    ["node_ls_1_0", "admin"],
    ["nginx_ls_1_0", "admin"],
  ])("%s logs in as %s", (blueprint, user) => {
    expect(loginUserOf(blueprint)).toBe(user);
  });
  it("an unknown image has no guess", () => {
    expect(loginUserOf("something_new")).toBeNull();
    expect(loginUserOf(undefined)).toBeNull();
  });
  it("the default image of the platform has a known user", () => {
    expect(loginUserOf(DEFAULT_BLUEPRINT_ID)).toBe("ubuntu");
  });
});

// WPU-Z19 (verify review, JOURNEY.md:1098): GetInstance `username` is "The user name for connecting to the instance".
// The provisioner stores it in the resource config; the panel prefers it over the table of image prefixes.
describe("storedLoginUserOf", () => {
  it("reads the user the instance reported, and only a plain user name", () => {
    expect(storedLoginUserOf({ loginUser: "admin" })).toBe("admin");
    expect(storedLoginUserOf({ loginUser: "bitnami" })).toBe("bitnami");
    for (const bad of [undefined, null, "", "Admin", "root; rm", "a".repeat(40), 5]) {
      expect(storedLoginUserOf({ loginUser: bad }), String(bad)).toBeNull();
    }
    expect(storedLoginUserOf(null)).toBeNull();
    expect(storedLoginUserOf("x")).toBeNull();
  });
});

describe("sshCommandOf", () => {
  it("names the key file after the customer's key and the real user", () => {
    expect(sshCommandOf({ user: "ubuntu", host: "203.0.113.10", keyName: "my laptop" })).toBe(
      "ssh -i my_laptop.pem ubuntu@203.0.113.10",
    );
  });
  it("never lets a key name break out of the command", () => {
    const cmd = sshCommandOf({
      user: "ubuntu",
      host: "203.0.113.10",
      keyName: "a;rm -rf /`x`$(y)",
    });
    expect(cmd).toBe("ssh -i a_rm_-rf___x___y_.pem ubuntu@203.0.113.10");
    expect(cmd).not.toMatch(/[;`$()]/);
  });
  it("without a key the command has no -i", () => {
    expect(sshCommandOf({ user: "ubuntu", host: "203.0.113.10", keyName: null })).toBe(
      "ssh ubuntu@203.0.113.10",
    );
  });
  it("an unknown user or a host that is not an address gives no command", () => {
    expect(sshCommandOf({ user: null, host: "203.0.113.10", keyName: "k" })).toBeNull();
    expect(sshCommandOf({ user: "ubuntu", host: "evil; ls", keyName: "k" })).toBeNull();
  });
});

describe("parseServerDisplayName", () => {
  it("is the rule of the create form", () => {
    expect(parseServerDisplayName(" web-1 ")).toBe("web-1");
    expect(parseServerDisplayName("")).toBeNull();
    expect(parseServerDisplayName("a".repeat(61))).toBeNull();
    expect(parseServerDisplayName("a<b>")).toBeNull();
    expect(parseServerDisplayName(5)).toBeNull();
  });
});

describe("WPU-Y1 Lightsail-packaged images", () => {
  it("tells a Lightsail-packaged id from a Bitnami one", () => {
    for (const id of ["wordpress_ls_1_0", "lamp_ls_1_0", "node_ls_1_0", "nginx_ls_1_0"])
      expect(isLightsailPackaged(id), id).toBe(true);
    for (const id of ["wordpress", "lamp_8_bitnami", "nodejs", "nginx", "ubuntu_24_04", undefined])
      expect(isLightsailPackaged(id), String(id)).toBe(false);
  });
  it("names the password file only where the Lightsail guides do", () => {
    expect(appPasswordFileOf("lamp_ls_1_0")).toBe("~/application_credentials");
    expect(appPasswordFileOf("node_ls_1_0")).toBe("~/application_credentials");
    expect(appPasswordFileOf("wordpress")).toBe("~/bitnami_application_password");
    // WordPress (Lightsail) is read from the console command; Nginx (Lightsail) is not documented: no guess.
    expect(appPasswordFileOf("wordpress_ls_1_0")).toBeNull();
    expect(appPasswordFileOf("nginx_ls_1_0")).toBeNull();
    expect(appPasswordFileOf("ubuntu_24_04")).toBeNull();
  });
});
