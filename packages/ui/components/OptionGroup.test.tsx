// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { OptionGroup } from "./OptionGroup";

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

describe("OptionGroup radio", () => {
  it("has the markup of the mockup (configurator.html)", () => {
    const { container, getByRole, getByLabelText } = renderKit(
      <OptionGroup kind="radio" name="ram" legend="RAM" options={options} defaultValue="b" />,
    );
    const block = container.firstElementChild as HTMLElement;
    expect([...block.classList]).toEqual(["cd-filter-block"]);
    const fieldset = block.firstElementChild as HTMLElement;
    expect(fieldset.tagName).toBe("FIELDSET");
    const legend = fieldset.querySelector(":scope > legend") as HTMLElement;
    expect([...legend.classList]).toEqual(["seccolor", "h6", "mb-4"]);
    const list = fieldset.querySelector(":scope > ul") as HTMLElement;
    expect([...list.classList]).toEqual([
      "radio-group",
      "radios-filter",
      "cd-filter-content",
      "list",
    ]);
    expect(list.querySelectorAll(":scope > li")).toHaveLength(3);
    expect(getByRole("group", { name: "RAM" })).toBe(fieldset);
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(3);
    expect(radios.every((r) => r.name === "ram")).toBe(true);
    expect(radios.map((r) => r.value)).toEqual(["a", "b", "c"]);
    expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
    expect((getByLabelText("Gamma") as HTMLInputElement).value).toBe("c");
    const label = container.querySelector("label") as HTMLElement;
    expect([...label.classList]).toEqual(["radio-label", "seccolor"]);
    expect(unknownClasses(container)).toEqual([]);
  });

  it("disables a disabled option and marks a required group", () => {
    const { getByLabelText } = renderKit(
      <OptionGroup
        kind="radio"
        name="ram"
        legend="RAM"
        required
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta", disabled: true },
        ]}
      />,
    );
    expect((getByLabelText("Beta") as HTMLInputElement).disabled).toBe(true);
    expect((getByLabelText("Alpha") as HTMLInputElement).required).toBe(true);
  });

  it("ties the hint and the error to the group", () => {
    const { container, getByRole } = renderKit(
      <OptionGroup
        kind="radio"
        name="ram"
        legend="RAM"
        options={options}
        hint="Pick one"
        error="Required"
      />,
      { locale: "en" },
    );
    const fieldset = container.querySelector("fieldset") as HTMLElement;
    const hint = container.querySelector("p.form-text") as HTMLElement;
    const alert = getByRole("alert");
    expect(fieldset.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (fieldset.getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy).toEqual([hint.id, alert.id]);
    expect(alert.classList.contains("tc-field-error")).toBe(true);
    expect(alert.querySelector("i[aria-hidden='true']")).not.toBeNull();
    expect(alert.querySelector(".visually-hidden")?.textContent).toBe("Error:");
    expect(alert.textContent).toContain("Required");
  });

  it("has no aria-invalid and no description without hint and error", () => {
    const { container } = renderKit(
      <OptionGroup kind="radio" name="ram" legend="RAM" options={options} />,
    );
    const fieldset = container.querySelector("fieldset") as HTMLElement;
    expect(fieldset.getAttribute("aria-invalid")).toBeNull();
    expect(fieldset.getAttribute("aria-describedby")).toBeNull();
  });

  it("throws for one option and for duplicate values", () => {
    expect(() =>
      renderKit(
        <OptionGroup kind="radio" name="x" legend="X" options={[{ value: "a", label: "A" }]} />,
      ),
    ).toThrow(RangeError);
    expect(() =>
      renderKit(
        <OptionGroup
          kind="radio"
          name="x"
          legend="X"
          options={[
            { value: "a", label: "A" },
            { value: "a", label: "B" },
          ]}
        />,
      ),
    ).toThrow(RangeError);
  });
});

describe("OptionGroup checkbox", () => {
  it("checks the default values", () => {
    const { container } = renderKit(
      <OptionGroup
        kind="checkbox"
        name="addons"
        legend="Add-ons"
        options={options}
        defaultValue={["a", "c"]}
      />,
    );
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, true]);
    expect(boxes.every((b) => b.name === "addons")).toBe(true);
    expect(container.querySelector("label.checkbox-label.seccolor")).not.toBeNull();
    expect(container.querySelector("fieldset > legend")?.textContent).toBe("Add-ons");
    expect(unknownClasses(container)).toEqual([]);
  });

  it("shows the hint of an option", () => {
    const { container } = renderKit(
      <OptionGroup
        kind="checkbox"
        name="addons"
        legend="Add-ons"
        options={[{ value: "a", label: "Alpha", hint: "Extra" }]}
      />,
    );
    expect(container.textContent).toContain("Extra");
  });
});

describe("OptionGroup select", () => {
  it("renders the select of the mockup with the selected option", () => {
    const { container, getByLabelText } = renderKit(
      <OptionGroup kind="select" name="os" legend="System" options={options} defaultValue="c" />,
    );
    const wrap = container.firstElementChild as HTMLElement;
    expect([...wrap.classList]).toEqual(["cd-select"]);
    const label = wrap.querySelector(":scope > label") as HTMLElement;
    expect([...label.classList]).toEqual(["seccolor"]);
    const select = getByLabelText("System") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.classList.contains("select-filter")).toBe(true);
    expect(select.name).toBe("os");
    expect(select.options).toHaveLength(3);
    expect(select.value).toBe("c");
    expect(label.getAttribute("for")).toBe(select.id);
    expect(unknownClasses(container)).toEqual([]);
  });

  it("allows one option and rejects none and duplicates", () => {
    const { container } = renderKit(
      <OptionGroup
        kind="select"
        name="os"
        legend="System"
        options={[{ value: "a", label: "A" }]}
      />,
    );
    expect(container.querySelectorAll("option")).toHaveLength(1);
    expect(() =>
      renderKit(<OptionGroup kind="select" name="os" legend="System" options={[]} />),
    ).toThrow(RangeError);
    expect(() =>
      renderKit(
        <OptionGroup
          kind="select"
          name="os"
          legend="System"
          options={[
            { value: "a", label: "A" },
            { value: "a", label: "B" },
          ]}
        />,
      ),
    ).toThrow(RangeError);
  });

  it("ties hint and error to the select and disables an option", () => {
    const { container, getByRole } = renderKit(
      <OptionGroup
        kind="select"
        name="os"
        legend="System"
        hint="Choose"
        error="Bad"
        required
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B", disabled: true },
        ]}
      />,
      { locale: "en" },
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(select.required).toBe(true);
    expect(select.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
    expect(getByRole("alert").textContent).toContain("Bad");
    expect(select.options[1]?.disabled).toBe(true);
  });
});

describe("OptionGroup output", () => {
  it("has no style attribute in bn and en", () => {
    for (const kind of ["radio", "checkbox", "select"] as const) {
      for (const locale of ["bn", "en"] as const) {
        expect(
          ssr(<OptionGroup kind={kind} name="n" legend="L" options={options} error="E" />, {
            locale,
          }),
        ).not.toContain(" style=");
      }
    }
  });
});
