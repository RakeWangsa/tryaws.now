// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { Button } from "./Button";
import { ErrorPage } from "./ErrorPage";

describe("ErrorPage", () => {
  it("is an alert with the icon, title and message", () => {
    const { container } = renderKit(
      <ErrorPage title="Something went wrong" message="Try again." />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("role")).toBe("alert");
    expect(root.classList.contains("tc-error")).toBe(true);
    expect(root.classList.contains("text-center")).toBe(true);
    const icon = root.querySelector("i.fas.fa-exclamation-triangle") as HTMLElement;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector("h2.h4.mergecolor")?.textContent).toBe("Something went wrong");
    expect(root.querySelector("p.seccolor")?.textContent).toBe("Try again.");
  });

  it("shows the reference in both locales", () => {
    const en = renderKit(<ErrorPage title="T" message="M" referenceId="err_1a2b3c" />, {
      locale: "en",
    });
    expect(en.container.querySelector("p.small.c-grey")?.textContent).toBe("Reference: err_1a2b3c");
    en.unmount();
    const bn = renderKit(<ErrorPage title="T" message="M" referenceId="err_1a2b3c" />, {
      locale: "bn",
    });
    expect(bn.container.querySelector("p.small.c-grey")?.textContent).toBe("রেফারেন্স: err_1a2b3c");
  });

  it("does not show a malformed reference id", () => {
    const bad = [
      "x",
      "bad id with spaces",
      "a".repeat(200),
      "arn:aws:iam::123:role/x",
      "abcde",
      "",
    ];
    for (const referenceId of bad) {
      const { container, unmount } = renderKit(
        <ErrorPage title="T" message="M" referenceId={referenceId} />,
        { locale: "en" },
      );
      expect(container.textContent, referenceId).not.toContain("Reference");
      expect(container.querySelectorAll("p").length).toBe(1);
      unmount();
    }
  });

  it("accepts the edges of the reference id rule (6 and 64 characters)", () => {
    for (const referenceId of ["abc_-9", "A".repeat(64)]) {
      const { container, unmount } = renderKit(
        <ErrorPage title="T" message="M" referenceId={referenceId} />,
        { locale: "en" },
      );
      expect(container.textContent).toContain(`Reference: ${referenceId}`);
      unmount();
    }
  });

  it("shows only the strings it was given (nothing from AWS of its own)", () => {
    const { container } = renderKit(
      <ErrorPage title="Title" message="Message" referenceId="err_123456" />,
      { locale: "en" },
    );
    expect(container.textContent).toBe("TitleMessageReference: err_123456");
    expect(container.textContent).not.toContain("arn:aws");
  });

  it("renders the retry and home nodes", () => {
    const { container } = renderKit(
      <ErrorPage
        title="T"
        message="M"
        retry={<Button>Retry</Button>}
        home={<Button href="/">Home</Button>}
      />,
    );
    expect(container.querySelector("button")?.textContent).toBe("Retry");
    expect(container.querySelector("a.btn")?.textContent).toBe("Home");
  });

  it("uses only known classes and no inline style, in both locales", () => {
    const ui = <ErrorPage title="T" message="M" referenceId="err_123456" />;
    for (const locale of ["bn", "en"] as const) {
      const { container, unmount } = renderKit(ui, { locale });
      expect(unknownClasses(container)).toEqual([]);
      unmount();
    }
    expect(ssr(ui)).not.toContain(" style=");
  });
});
