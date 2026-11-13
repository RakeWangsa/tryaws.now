import { expect, it } from "vitest";
import {
  FIRST_ADMIN_NOT_CONFIGURED,
  firstAdminDecision,
  canonicalCognitoSub,
  subPrefix,
} from "../repositories/system/first-admin";

// WPU-Z18: the pure half of the first-superadmin bootstrap. No database.
const SUB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

it("accepts only the canonical UUID form, either case, and normalises to lowercase", () => {
  expect(canonicalCognitoSub(SUB)).toBe(SUB);
  expect(canonicalCognitoSub(SUB.toUpperCase())).toBe(SUB);
  for (const bad of [
    "",
    " " + SUB,
    SUB + " ",
    SUB + "\n",
    SUB.replace(/-/g, ""),
    "{" + SUB + "}",
    "urn:uuid:" + SUB,
    SUB.slice(0, 35),
    SUB + "0",
    SUB.replace("0a", "0g"),
    "not-configured",
    "sub-123",
    undefined,
    null,
    42,
    {},
  ]) {
    expect(canonicalCognitoSub(bad), String(bad)).toBeUndefined();
  }
});

it("decides: no secret for unset, empty or the not-configured placeholder; malformed otherwise; run for a UUID", () => {
  expect(FIRST_ADMIN_NOT_CONFIGURED).toBe("not-configured");
  expect(firstAdminDecision(undefined)).toEqual({ kind: "skip", decision: "skipped: no secret" });
  expect(firstAdminDecision("")).toEqual({ kind: "skip", decision: "skipped: no secret" });
  expect(firstAdminDecision("not-configured")).toEqual({
    kind: "skip",
    decision: "skipped: no secret",
  });
  expect(firstAdminDecision("sub-123")).toEqual({ kind: "skip", decision: "skipped: malformed" });
  expect(firstAdminDecision(SUB.toUpperCase())).toEqual({ kind: "run", sub: SUB });
});

it("shows at most the first 8 characters of a sub (R14)", () => {
  expect(subPrefix(SUB)).toBe("0a1b2c3d");
  expect(subPrefix(SUB)).toHaveLength(8);
});
