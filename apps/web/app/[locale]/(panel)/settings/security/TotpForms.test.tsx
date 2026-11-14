import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../../i18n/messages.ts";

// WPU-X11: the authenticator setup after the server answered the start action. The secret is in the
// answer of the action only (U9), shown grouped with the otpauth link, and hidden again after 60 s.

const answers: unknown[] = [];
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useActionState: () => [answers.shift() ?? {}, () => undefined, false],
  };
});

const { SECRET_VISIBLE_MS, TotpSetupForms, groupSecret } = await import("./TotpForms.tsx");

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/TryAWS.now?secret=${SECRET}&issuer=TryAWS.now&algorithm=SHA1&digits=6&period=30`;
const never = async (): Promise<never> => {
  throw new Error("not called in a render");
};

function render(locale: "bn" | "en", started: unknown, confirmed: unknown = {}): string {
  answers.length = 0;
  answers.push(started, confirmed);
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      <TotpSetupForms start={never} confirm={never} signInHref="/login" />
    </NextIntlClientProvider>,
  );
}

describe("TotpSetupForms", () => {
  it("before the start: only the start button, no secret and no code field", () => {
    const html = render("en", {});
    expect(html).toContain("Switch on the authenticator");
    expect(html).not.toContain('name="code"');
  });

  it("after the start: the secret in groups of four, the app link, the once-only note and the code field", () => {
    const html = render("en", {
      done: "started",
      secret: SECRET,
      otpauthUri: URI,
      qr: { size: 21, margin: 4, d: "M4 4h1v1h-1z" },
    });
    // The QR code as one inline SVG path made on the server, labelled, with no style attribute (U4).
    expect(html).toContain('<svg class="tc-totp-qr"');
    expect(html).toContain('viewBox="0 0 29 29"');
    expect(html).toContain('d="M4 4h1v1h-1z"');
    expect(html).toContain('aria-label="QR code to scan with your authenticator app"');
    expect(html).not.toContain("style=");
    expect(html).toContain(groupSecret(SECRET));
    expect(groupSecret(SECRET)).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    expect(html).toContain(`href="${URI.replace(/&/g, "&amp;")}"`);
    expect(html).toContain("shown only once and is hidden after 60 seconds");
    expect(html).toContain('name="code"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(render("bn", { done: "started", secret: SECRET, otpauthUri: URI })).toContain("গোপন কী");
    expect(SECRET_VISIBLE_MS).toBe(60_000);
  });

  it("a wrong code shows the field error; a confirmed code shows the success text", () => {
    const wrong = render(
      "en",
      { done: "started", secret: SECRET, otpauthUri: URI },
      { error: "invalid_code", fields: { code: "wrong" } },
    );
    expect(wrong).toContain('role="alert"');
    expect(render("en", { done: "started", secret: SECRET }, { done: "enabled" })).toContain(
      "The authenticator is on.",
    );
  });

  it("a fresh sign-in error links to the sign-in", () => {
    const html = render("en", { error: "fresh_sign_in_required" });
    expect(html).toContain('href="/login"');
  });
});
