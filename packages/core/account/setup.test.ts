import { describe, expect, it } from "vitest";
import { ACCOUNT_SETUP_STEPS, canBuy, missingSetupSteps, type AccountSetupFacts } from "./setup";

// WPU-X11 (owner decision 2026-11-14): a customer may buy when the e-mail is verified, the mobile is
// verified and an authenticator (TOTP) is switched on. KYC is no longer a condition.

const AT = new Date("2026-11-14T10:00:00Z");
const ALL: AccountSetupFacts = { emailVerifiedAt: AT, phoneVerifiedAt: AT, totpEnabledAt: AT };

describe("canBuy / missingSetupSteps: the truth table of the three facts", () => {
  for (const email of [true, false]) {
    for (const phone of [true, false]) {
      for (const totp of [true, false]) {
        const facts: AccountSetupFacts = {
          emailVerifiedAt: email ? AT : null,
          phoneVerifiedAt: phone ? AT : null,
          totpEnabledAt: totp ? AT : null,
        };
        const expected = [
          ...(email ? [] : ["email"]),
          ...(phone ? [] : ["phone"]),
          ...(totp ? [] : ["totp"]),
        ];
        it(`email ${email}, phone ${phone}, totp ${totp}`, () => {
          expect(missingSetupSteps(facts)).toEqual(expected);
          expect(canBuy(facts)).toBe(email && phone && totp);
        });
      }
    }
  }

  it("lists the steps in the order the customer meets them", () => {
    expect(ACCOUNT_SETUP_STEPS).toEqual(["email", "phone", "totp"]);
  });

  it("fails closed: a value that is not a valid Date proves nothing (R16)", () => {
    for (const bad of [undefined, "2026-11-14", 0, 1, true, {}, new Date(Number.NaN)]) {
      for (const key of ["emailVerifiedAt", "phoneVerifiedAt", "totpEnabledAt"] as const) {
        const facts = { ...ALL, [key]: bad } as unknown as AccountSetupFacts;
        expect(canBuy(facts)).toBe(false);
      }
    }
    expect(canBuy(null)).toBe(false);
    expect(canBuy(undefined as unknown as AccountSetupFacts)).toBe(false);
    expect(missingSetupSteps(null)).toEqual(["email", "phone", "totp"]);
  });

  it("does not read KYC: a profile with KYC none and all three facts may buy", () => {
    expect(canBuy({ ...ALL, kycStatus: "none" } as AccountSetupFacts)).toBe(true);
  });
});
