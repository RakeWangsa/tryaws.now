import { describe, expect, it } from "vitest";
import { toProfileScreen } from "../../../../server/settings-view.ts";
import { SCREEN, profile, security } from "./mockup-states.tsx";

describe("/settings/profile", () => {
  it("shows the name, the language choice, the masked phone and the current e-mail, never a full number", () => {
    const html = profile(SCREEN)("en");
    expect(html).toContain("karim@example.test");
    expect(html).toContain("+88017••••5678");
    expect(html).not.toMatch(/\+8801[0-9]{9}/);
    expect(html).toContain('name="name"');
    expect(html).toContain('value="bn"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="phone"');
  });

  it("asks for the code only after the server accepted the new address or number", () => {
    const html = profile(SCREEN)("en");
    expect(html).not.toContain('name="code"');
  });

  it("when the provider adapters are not configured, e-mail and phone show the not-open state and no form field", () => {
    const html = profile({ ...SCREEN, open: false })("en");
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('name="phone"');
    expect(html).toContain("This change is not open yet");
    expect(html).toContain('name="name"');
  });

  it("explains the fresh sign-in rule in both languages, Bengali first", () => {
    expect(profile(SCREEN)("bn")).toMatch(/১০ মিনিট/);
    expect(profile(SCREEN)("en")).toContain("last 10 minutes");
  });

  it("toProfileScreen masks the phone and marks it verified only with a time", () => {
    const base = {
      name: null,
      email: "a@example.test",
      phone: "+8801712345678",
      phoneVerifiedAt: null,
      locale: "bn" as const,
    };
    expect(toProfileScreen(base, true)).toMatchObject({ name: "", phoneVerified: false });
    expect(toProfileScreen(base, true).phoneMasked).not.toContain("1712345");
    expect(toProfileScreen({ ...base, phoneVerifiedAt: new Date() }, true).phoneVerified).toBe(
      true,
    );
    expect(toProfileScreen({ ...base, phone: null }, false)).toMatchObject({
      phoneMasked: null,
      open: false,
    });
  });
});

describe("/settings/security", () => {
  it("has the three password fields with the right autocomplete and no value", () => {
    const html = security(true)("en");
    expect(html).toContain('name="currentPassword"');
    expect(html).toContain('name="newPassword"');
    expect(html).toContain('name="confirmPassword"');
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toMatch(/autoComplete="current-password"|autocomplete="current-password"/);
    expect(html.match(/new-password/g)).toHaveLength(2);
    expect(html).not.toMatch(/type="password"[^>]*value=/);
  });

  it("is not open without the identity adapter", () => {
    const html = security(false)("bn");
    expect(html).not.toContain('type="password"');
    expect(html).toMatch(/[ঀ-৿]/);
  });
});
