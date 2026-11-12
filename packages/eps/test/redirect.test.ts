import { describe, expect, it } from "vitest";
import {
  checkGatewayRedirect,
  EPS_REDIRECT_HOSTS,
  EPS_TEST_REDIRECT_HOSTS,
  gatewayFormOrigins,
} from "../redirect";

describe("checkGatewayRedirect", () => {
  it.each([
    ["https://pg.eps.com.bd/PG?data=1", "https://pg.eps.com.bd/PG?data=1"],
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

  it("the test host is refused by default, which is the production behaviour (WPU-D3, C.7)", () => {
    expect(checkGatewayRedirect("https://pg.eps.test/PG?data=7")).toBeNull();
    expect(checkGatewayRedirect("https://pg.eps.test/PG?data=7", {})).toBeNull();
    expect(
      checkGatewayRedirect("https://pg.eps.test/PG?data=7", { allowTestHosts: false }),
    ).toBeNull();
  });

  it("the test host passes only when the stage allows test hosts; the real host passes always", () => {
    expect(checkGatewayRedirect("https://pg.eps.test/PG?data=7", { allowTestHosts: true })).toBe(
      "https://pg.eps.test/PG?data=7",
    );
    expect(checkGatewayRedirect("https://pg.eps.com.bd/x", { allowTestHosts: false })).toBe(
      "https://pg.eps.com.bd/x",
    );
    // the other refusals hold with the flag on
    expect(checkGatewayRedirect("http://pg.eps.test/x", { allowTestHosts: true })).toBeNull();
    expect(checkGatewayRedirect("https://evil.pg.eps.test/x", { allowTestHosts: true })).toBeNull();
  });

  it.each([undefined, null, 5, {}, [], ["https://pg.eps.com.bd/"], true])(
    "a non-string (%s) is refused",
    (input) => {
      expect(checkGatewayRedirect(input)).toBeNull();
    },
  );
});

describe("the lists", () => {
  it("the production list holds the real host only; the test host is a separate list", () => {
    expect([...EPS_REDIRECT_HOSTS]).toEqual(["pg.eps.com.bd"]);
    expect([...EPS_TEST_REDIRECT_HOSTS]).toEqual(["pg.eps.test"]);
  });

  it("the form-action origins hold only the real host, never the .test host", () => {
    expect(gatewayFormOrigins()).toEqual(["https://pg.eps.com.bd"]);
  });
});
