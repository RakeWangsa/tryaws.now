import { expect, it } from "vitest";
import { checkPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password";
import { COMMON_PASSWORDS } from "./common-passwords";

const ok = { ok: true };
const issue = (i: string) => ({ ok: false, issue: i });

it("has the documented bounds", () => {
  expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([12, 128]);
});

it("11 characters are too short, 12 and 128 pass, 129 are too long", () => {
  expect(checkPassword("Xk9#mQ2$vL7")).toEqual(issue("too_short"));
  expect(checkPassword("Xk9#mQ2$vL7p")).toEqual(ok);
  expect(checkPassword("Xk9#".repeat(32))).toEqual(ok);
  expect(checkPassword("Xk9#".repeat(32) + "a")).toEqual(issue("too_long"));
});

it("counts code points, not UTF-16 units", () => {
  expect(checkPassword("কখগঘঙচছজঝঞটঠ")).toEqual(ok);
  expect(checkPassword("কখগঘঙচছজঝঞট")).toEqual(issue("too_short"));
  // 11 emoji are 22 UTF-16 units but 11 code points
  expect(checkPassword("😀😁😂🤣😃😄😅😆😉😊😋")).toEqual(issue("too_short"));
  // eleven letters plus one combining mark: counted as typed, 12 code points
  expect(checkPassword("কখগঘঙচছজঝঞট়")).toEqual(ok);
});

it("does not trim", () => {
  expect(checkPassword(" Xk9#mQ2$vL7")).toEqual(ok);
  expect(checkPassword("Xk9#mQ2$vL7 ")).toEqual(ok);
  expect(checkPassword("Xk9#mQ2$vL ")).toEqual(issue("too_short"));
});

it("compares with the address and its local part, any case", () => {
  const email = "rahim.uddin@example.com";
  expect(checkPassword(email, email)).toEqual(issue("same_as_email"));
  expect(checkPassword(email.toUpperCase(), email)).toEqual(issue("same_as_email"));
  expect(checkPassword("Rahim.Uddin.1", "rahim.uddin.1@example.com")).toEqual(
    issue("same_as_email"),
  );
  expect(checkPassword("Xk9#mQ2$vL7p", "rahim@example.com")).toEqual(ok);
});

it("refuses list entries in any case", () => {
  expect(COMMON_PASSWORDS.length).toBeGreaterThanOrEqual(120);
  for (const p of COMMON_PASSWORDS) {
    expect(Array.from(p).length).toBeGreaterThanOrEqual(12);
    expect(p).toBe(p.toLowerCase());
  }
  expect(checkPassword("password1234")).toEqual(issue("too_common"));
  expect(checkPassword("PassWord1234")).toEqual(issue("too_common"));
  expect(checkPassword("123456789012")).toEqual(issue("too_common"));
  expect(checkPassword("QWERTYUIOPAS")).toEqual(issue("too_common"));
  expect(checkPassword("iloveyou1234")).toEqual(issue("too_common"));
});

it("refuses a repeated character or block", () => {
  expect(checkPassword("aaaaaaaaaaaa")).toEqual(issue("repeated"));
  expect(checkPassword("abababababab")).toEqual(issue("repeated"));
});

it("refuses control characters", () => {
  expect(checkPassword("Xk9#mQ2$vL7\u0000")).toEqual(issue("required"));
  expect(checkPassword("Xk9#mQ2$vL7\u0007")).toEqual(issue("required"));
  expect(checkPassword("Xk9#mQ2$vL7\u0085")).toEqual(issue("required"));
});

it.each([undefined, null, 1, ["x"], {}, ""])("%j is required", (v) => {
  expect(checkPassword(v)).toEqual(issue("required"));
});
