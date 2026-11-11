// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { Field, FormBlock, fieldIds } from "./Field";

// Not `new URL(...)`: in a jsdom test Vite rewrites that form to an http URL.
const tcCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../styles/tc.css"),
  "utf8",
);

describe("fieldIds", () => {
  it("returns the three element ids", () => {
    expect(fieldIds("x")).toEqual({ input: "x", hint: "x-hint", error: "x-error" });
  });
});

describe("Field", () => {
  it("ties the label to the input", () => {
    const { getByLabelText, container } = renderKit(<Field name="email" label="Email" id="e" />);
    const input = getByLabelText("Email") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.id).toBe("e");
    expect(input.name).toBe("email");
    const root = container.firstElementChild as HTMLElement;
    expect([...root.classList]).toEqual(["position-relative", "mb-3"]);
    expect(root.querySelector("label")?.className).toBe("seccolor");
  });

  it("has no aria-describedby without a hint and without an error", () => {
    const { getByLabelText } = renderKit(<Field name="n" label="Name" id="n1" />);
    expect(getByLabelText("Name").getAttribute("aria-describedby")).toBeNull();
    expect(getByLabelText("Name").getAttribute("aria-invalid")).toBeNull();
  });

  it("points to the hint only", () => {
    const { getByLabelText, container } = renderKit(
      <Field name="n" label="Name" id="n1" hint="Your full name" />,
    );
    expect(getByLabelText("Name").getAttribute("aria-describedby")).toBe("n1-hint");
    const hint = container.querySelector("#n1-hint") as HTMLElement;
    expect(hint.tagName).toBe("P");
    expect(hint.className).toBe("form-text seccolor");
    expect(hint.textContent).toBe("Your full name");
    expect(container.querySelector("#n1-error")).toBeNull();
  });

  it("points to the error only", () => {
    const { getByLabelText } = renderKit(<Field name="n" label="Name" id="n1" error="Required" />);
    expect(getByLabelText("Name").getAttribute("aria-describedby")).toBe("n1-error");
  });

  it("lists the hint first, then the error", () => {
    const { getByLabelText } = renderKit(
      <Field name="n" label="Name" id="n1" hint="Hint" error="Required" />,
    );
    expect(getByLabelText("Name").getAttribute("aria-describedby")).toBe("n1-hint n1-error");
  });

  it("shows the error as an alert with an icon and a hidden word", () => {
    const { container, getByLabelText } = renderKit(
      <Field name="n" label="Name" id="n1" error="Required" />,
      { locale: "en" },
    );
    const error = container.querySelector("#n1-error") as HTMLElement;
    expect(error.tagName).toBe("P");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.className).toBe("tc-field-error");
    const icon = error.querySelector("i") as HTMLElement;
    expect(icon.className).toBe("fas fa-exclamation-circle me-1");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    const word = error.querySelector("span.visually-hidden") as HTMLElement;
    expect(word.textContent).toBe("Error:");
    expect(error.textContent).toBe("Error:Required");
    expect(getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
  });

  it("sets aria-invalid only with an error", () => {
    const a = renderKit(<Field name="n" label="Name" id="a" />);
    expect(a.container.querySelector("[aria-invalid]")).toBeNull();
    a.unmount();
    const b = renderKit(<Field name="n" label="Name" id="b" error="x" />);
    expect(b.container.querySelector("input")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("renders a textarea when multiline", () => {
    const { container, getByLabelText } = renderKit(
      <Field name="notes" label="Notes" id="t" multiline rows={4} hint="h" />,
    );
    const area = getByLabelText("Notes") as HTMLTextAreaElement;
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.className).toBe("form-control");
    expect(area.rows).toBe(4);
    expect(area.getAttribute("aria-describedby")).toBe("t-hint");
    expect(container.querySelector("input")).toBeNull();
  });

  it("shows the optional word", () => {
    const { container } = renderKit(<Field name="n" label="Name" id="o" optional />, {
      locale: "en",
    });
    const word = container.querySelector("label span.c-grey") as HTMLElement;
    expect(word.textContent).toContain("Optional");
  });

  it("shows no optional word by default", () => {
    const { container } = renderKit(<Field name="n" label="Name" id="o" />);
    expect(container.querySelector("span.c-grey")).toBeNull();
  });

  it("shows the icon inside the label", () => {
    const { container } = renderKit(<Field name="n" label="Name" id="i" icon="fas fa-user-tie" />);
    const icon = container.querySelector("label i") as HTMLElement;
    expect(icon.className).toBe("fas fa-user-tie me-2");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the type and passes other attributes to the control", () => {
    const { container } = renderKit(
      <Field
        name="p"
        label="Password"
        id="p"
        type="password"
        autoComplete="current-password"
        required
      />,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("current-password");
    expect(input.required).toBe(true);
  });

  it("defaults the type to text", () => {
    const { container } = renderKit(<Field name="p" label="P" id="p" />);
    expect((container.querySelector("input") as HTMLInputElement).type).toBe("text");
  });

  it("generates different ids for two fields", () => {
    const { container } = renderKit(
      <>
        <Field name="a" label="A" hint="h" />
        <Field name="b" label="B" hint="h" />
      </>,
    );
    const [one, two] = [...container.querySelectorAll("input")];
    expect(one?.id).not.toBe("");
    expect(one?.id).not.toBe(two?.id);
    expect(one?.getAttribute("aria-describedby")).toBe(`${one?.id}-hint`);
  });

  it("renders in bn and en", () => {
    const bn = renderKit(<Field name="n" label="Name" id="x" optional error="e" />, {
      locale: "bn",
    });
    expect(bn.container.textContent).toContain("ঐচ্ছিক");
    expect(bn.container.textContent).toContain("ত্রুটি:");
    bn.unmount();
    const en = renderKit(<Field name="n" label="Name" id="x" optional error="e" />, {
      locale: "en",
    });
    expect(en.container.textContent).toContain("Optional");
    expect(en.container.textContent).toContain("Error:");
  });

  it("uses only known classes and no style attribute", () => {
    const element = (
      <Field name="n" label="Name" id="x" icon="fas fa-user" optional hint="h" error="e" />
    );
    const { container } = renderKit(element);
    expect(unknownClasses(container)).toEqual([]);
    expect(ssr(element)).not.toContain(" style=");
    const area = <Field name="n" label="Name" id="x" multiline />;
    expect(unknownClasses(renderKit(area).container)).toEqual([]);
    expect(ssr(area)).not.toContain(" style=");
  });
});

describe("FormBlock", () => {
  it("wraps the children in the two filter classes", () => {
    const { container } = renderKit(
      <FormBlock className="mt-3">
        <p>child</p>
      </FormBlock>,
    );
    const block = container.firstElementChild as HTMLElement;
    expect(block.tagName).toBe("DIV");
    expect([...block.classList]).toEqual(["cd-filter-block", "mb-0", "mt-3"]);
    const content = block.firstElementChild as HTMLElement;
    expect(content.className).toBe("cd-filter-content");
    expect(content.firstElementChild?.tagName).toBe("P");
    expect(unknownClasses(container)).toEqual([]);
  });

  it("has exactly the two classes without a className", () => {
    const { container } = renderKit(<FormBlock>x</FormBlock>);
    expect((container.firstElementChild as HTMLElement).className).toBe("cd-filter-block mb-0");
  });
});

describe("tc.css sub-block 5.2", () => {
  it("styles .tc-field-error with weight 600, the danger color and a small top margin", () => {
    const start = tcCss.indexOf("/* ===== 5.2");
    const end = tcCss.indexOf("/* ===== 5.3");
    const block = tcCss.slice(start, end);
    const rule = /\.tc-field-error\s*\{([^}]*)\}/.exec(block);
    expect(rule, ".tc-field-error is defined in 5.2").not.toBeNull();
    const body = (rule?.[1] ?? "").replace(/\s+/g, " ");
    expect(body).toContain("font-weight: 600");
    expect(body).toContain("color: var(--bs-danger)");
    expect(body).toContain("margin: 0.25rem 0 0");
  });
});
