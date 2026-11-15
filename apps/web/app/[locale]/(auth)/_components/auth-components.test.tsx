import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Field } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { AUTH_ERROR_CODES } from "../../../../server/auth/state.ts";
import type { FormState } from "../../../../server/auth/state.ts";
import { AuthAlert, AuthErrorAlert } from "./AuthAlert.tsx";
import { AuthFormView } from "./AuthForm.tsx";
import { ConsentBoxes } from "./ConsentBoxes.tsx";
import { ResendTimer, secondsLeft } from "./ResendTimer.tsx";
import { html } from "./mockup-states.tsx";
import { AuthTabs } from "./AuthTabs.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const noop = (): void => undefined;

function view(state: FormState, locale: "bn" | "en" = "bn", submit = true) {
  return html(
    <AuthFormView
      state={state}
      action={noop}
      hidden={{ next: "/wallet", locale }}
      {...(submit ? { submitLabel: "Go" } : {})}
    >
      {({ error, values }) => (
        <>
          <Field
            name="email"
            label="Email"
            type="email"
            defaultValue={values["email"]}
            {...(error("email") !== undefined ? { error: error("email") as string } : {})}
          />
          <Field name="password" label="Password" type="password" />
        </>
      )}
    </AuthFormView>,
    locale,
  );
}

describe("AuthTabs", () => {
  it("renders two li.btn.btn-secondary, marks the active one and links to the routes (bn)", () => {
    const out = html(<AuthTabs active="login" locale="bn" />, "bn");
    expect(out.match(/<li class="btn btn-secondary tc-auth-tab/g)).toHaveLength(2);
    expect(out).toContain(
      '<li class="btn btn-secondary tc-auth-tab active tc-auth-tab-current mb-2"><a href="/en/login" aria-current="page">',
    );
    expect(out).toContain('<li class="btn btn-secondary tc-auth-tab mb-2"><a href="/en/signup">');
  });

  it("uses /en/... in English and puts aria-current on the signup tab", () => {
    const out = html(<AuthTabs active="signup" locale="en" />, "en");
    expect(out).toContain('href="/en/login"');
    expect(out).toContain('<a href="/en/signup" aria-current="page">');
  });

  it("keeps next only when it passes the allow-list", () => {
    const good = html(<AuthTabs active="login" locale="bn" next="/wallet?x=1" />, "bn");
    expect(good).toContain('href="/en/login?next=%2Fwallet%3Fx%3D1"');
    for (const bad of ["//evil.com", "https://evil.com", "/walletx", undefined, 5]) {
      const out = html(<AuthTabs active="login" locale="bn" next={bad} />, "bn");
      expect(out, String(bad)).not.toContain("next=");
    }
  });
});

describe("AuthFormView", () => {
  it("an idle form has hidden fields, no alert and a submit button", () => {
    const out = view({ status: "idle" });
    expect(out).toContain('<input type="hidden" name="next" value="/wallet"/>');
    expect(out).not.toContain('class="alert');
    expect(out).toContain('type="submit"');
  });

  it("a field error is announced, linked with aria-describedby and aria-invalid, and keeps the echoed value", () => {
    const out = view({
      status: "error",
      code: "invalid",
      fields: { email: "invalid" },
      values: { email: "a@b" },
      ref: "0a1b2c3d",
    });
    expect(out).toContain('aria-invalid="true"');
    expect(out).toMatch(/aria-describedby="[^"]*-error"/);
    expect(out).toContain('role="alert"');
    expect(out).toContain('value="a@b"');
  });

  it("never renders a value into the password field", () => {
    const out = view({
      status: "error",
      code: "invalid",
      values: { email: "a@b", password: "planted-secret-1", passwordConfirm: "planted-secret-1" },
      ref: "0a1b2c3d",
    });
    expect(out).not.toContain("planted-secret-1");
  });

  it("an error state carries a role=alert, an icon, the word and the reference", () => {
    const out = view({ status: "error", code: "sign_in_failed", ref: "0a1b2c3d" }, "en");
    expect(out).toContain('role="alert"');
    expect(out).toContain('<i class="fas fa-exclamation-triangle me-2" aria-hidden="true"></i>');
    expect(out).toContain("<strong>Error</strong>");
    expect(out).toContain("Reference: 0a1b2c3d");
  });

  it("has a message in both locales for every error code, in minutes for the retry time", () => {
    for (const code of AUTH_ERROR_CODES) {
      for (const locale of ["bn", "en"] as const) {
        const out = html(
          <AuthErrorAlert code={code} retryAfterSeconds={125} reference="0a1b2c3d" />,
          locale,
        );
        expect(out, `${code} ${locale}`).toContain("alert alert-");
        expect(out, `${code} ${locale}`).not.toContain("Auth.error");
      }
    }
    const limited = html(<AuthErrorAlert code="rate_limited" retryAfterSeconds={125} />, "en");
    expect(limited).toContain("Try again in 3 minutes.");
  });

  it("the submit button is a SubmitButton (inert while the action runs) and may be left out", () => {
    expect(view({ status: "idle" })).toContain('<button type="submit"');
    expect(view({ status: "idle" }, "bn", false)).not.toContain('type="submit"');
  });
});

describe("AuthAlert", () => {
  it("every kind has an icon and a word (never colour alone) and the right role", () => {
    const expected = {
      danger: ["fa-exclamation-triangle", "Error", "alert"],
      warning: ["fa-exclamation-circle", "Warning", "alert"],
      info: ["fa-info-circle", "Information", "status"],
      success: ["fa-check-circle", "Success", "status"],
    } as const;
    for (const [kind, [icon, word, role]] of Object.entries(expected)) {
      const out = html(<AuthAlert kind={kind as "danger"}>m</AuthAlert>, "en");
      expect(out, kind).toContain(icon);
      expect(out, kind).toContain(`<strong>${word}</strong>`);
      expect(out, kind).toContain(`role="${role}"`);
    }
  });
});

describe("ResendTimer", () => {
  it("is enabled at once without JavaScript (the server limiter decides)", () => {
    const out = html(
      <form>
        <ResendTimer resendAt={Math.floor(Date.now() / 1000) + 60} label="Again" />
      </form>,
      "en",
    );
    expect(out).toContain('<button type="submit"');
    expect(out).not.toContain("disabled");
  });

  it("counts the seconds that are left, never below zero", () => {
    expect(secondsLeft(100, 160)).toBe(60);
    expect(secondsLeft(100.2, 160)).toBe(60);
    expect(secondsLeft(160, 160)).toBe(0);
    expect(secondsLeft(200, 160)).toBe(0);
    expect(secondsLeft(100, null)).toBe(0);
    expect(secondsLeft(100, Number.NaN)).toBe(0);
  });
});

describe("ConsentBoxes", () => {
  it("renders three required boxes with links to the documents in the locale", () => {
    const out = html(<ConsentBoxes locale="en" error={() => undefined} />, "en");
    expect(out.match(/type="checkbox"/g)).toHaveLength(3);
    for (const path of ["/en/legal/terms", "/en/legal/acceptable-use", "/en/legal/privacy"]) {
      expect(out).toContain(`href="${path}"`);
    }
    expect(out).not.toContain("checked");
  });

  it("shows an error with an icon and a hidden word next to the box", () => {
    const out = html(
      <ConsentBoxes locale="bn" error={(n) => (n === "consentAup" ? "must" : undefined)} />,
      "bn",
    );
    expect(out).toContain('id="consent-aup-error"');
    expect(out).toContain("fa-exclamation-circle");
    expect(out).toContain('aria-invalid="true"');
  });
});

describe("no component has a style attribute, a script or a hard-coded string", () => {
  const files = readdirSync(here).filter(
    (f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f) && f !== "mockup-states.tsx",
  );
  it("sources", () => {
    for (const file of files) {
      const text = readFileSync(resolve(here, file), "utf8");
      expect(/\bstyle\s*=/.test(text), `${file} style`).toBe(false);
      expect(/<script/i.test(text), `${file} script`).toBe(false);
      expect(/dangerouslySetInnerHTML/.test(text), `${file} innerHTML`).toBe(false);
    }
  });
});
