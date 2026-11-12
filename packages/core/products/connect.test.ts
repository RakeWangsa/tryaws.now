import { describe, expect, it } from "vitest";
import { DEFAULT_BLUEPRINT_ID, loginUserOf, parseServerDisplayName, sshCommandOf } from "./connect";

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
