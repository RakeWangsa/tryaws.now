import { describe, expect, it } from "vitest";
import { checkGatewayRedirect, EPS_REDIRECT_HOSTS, gatewayFormOrigins } from "../redirect";

describe("checkGatewayRedirect", () => {
  it.each([
    ["https://pg.eps.com.bd/PG?data=1", "https://pg.eps.com.bd/PG?data=1"],
    ["https://pg.eps.test/PG?data=7", "https://pg.eps.test/PG?data=7"],
    ["https://PG.EPS.COM.BD/x", "https://pg.eps.com.bd/x"],
    ["https://pg.eps.com.bd:443/x", "https://pg.eps.com.bd/x"],
  ])("%s passes as the normalised URL", (input, expected) => {
    expect(checkGatewayRedirect(input)).toBe(expected);
  });

  it.each([
    "http://pg.eps.com.bd/x",
    "//pg.eps.com.bd/x",
    "/dev/x",
    "https://pg.eps.com.bd.evil.com/",
    "https://evil.com/?u=pg.eps.com.bd",
    "https://user:pw@pg.eps.com.bd/",
    "https://user@pg.eps.com.bd/",
    "https://pg.eps.com.bd:8443/",
    "javascript:alert(1)",
    "data:text/html,x",
    "",
    "https://",
    "https://sub.pg.eps.com.bd/",
    "https://pg.eps.com.bd@evil.com/",
    "https://evil.com\\@pg.eps.com.bd/",
    "https://pg.eps.com.bd/" + "a".repeat(5000),
  ])("%j is refused", (input) => {
    expect(checkGatewayRedirect(input)).toBeNull();
  });

  it.each([undefined, null, 5, {}, [], ["https://pg.eps.com.bd/"], true])(
    "a non-string (%s) is refused",
    (input) => {
      expect(checkGatewayRedirect(input)).toBeNull();
    },
  );
});

describe("the lists", () => {
  it("lists the two hosts of the gateway", () => {
    expect([...EPS_REDIRECT_HOSTS]).toEqual(["pg.eps.com.bd", "pg.eps.test"]);
  });

  it("the form-action origins hold only the real host, never the .test host", () => {
    expect(gatewayFormOrigins()).toEqual(["https://pg.eps.com.bd"]);
  });
});
