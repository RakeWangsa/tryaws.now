// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { PlanPicker, type PickerPlan } from "./PlanPicker";

const plans: PickerPlan[] = [
  { id: "p1", name: "Nano", priceMinor: 50000n, lines: ["1 vCPU", "1 GB"] },
  { id: "p2", name: "Micro", priceMinor: 123450n, lines: ["2 vCPU", "2 GB"] },
  { id: "p3", name: "Small", priceMinor: 250000n, lines: ["2 vCPU", "4 GB"] },
];

function parts(container: HTMLElement) {
  return {
    hidden: container.querySelector('input[type="hidden"]') as HTMLInputElement,
    radios: [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')],
    range: container.querySelector('input[type="range"]') as HTMLInputElement,
  };
}

describe("PlanPicker", () => {
  it("renders a radio per plan and one range", () => {
    const { container } = renderKit(<PlanPicker name="plan" legend="Plan" plans={plans} />, {
      locale: "en",
    });
    const { radios, range } = parts(container);
    expect(radios).toHaveLength(3);
    expect(radios.every((r) => r.classList.contains("tc-plan-radio"))).toBe(true);
    expect(radios.every((r) => r.name === "plan__ui")).toBe(true);
    expect(range.getAttribute("min")).toBe("0");
    expect(range.getAttribute("max")).toBe("2");
    expect(range.getAttribute("step")).toBe("1");
    expect(range.getAttribute("aria-label")).toBe("Plan");
    expect(range.classList.contains("form-range")).toBe(true);
    expect(container.querySelector("fieldset > legend")?.textContent).toBe("Plan");
    expect(container.querySelector("ul.tc-plan-list.d-lg-none")).not.toBeNull();
    expect(container.querySelector("div.wpc-cloud-range.d-none.d-lg-block")).not.toBeNull();
    expect(unknownClasses(container)).toEqual([]);
  });

  it("selects the first plan by default and carries the id in the hidden input", () => {
    const { container } = renderKit(<PlanPicker name="plan" legend="Plan" plans={plans} />);
    const { hidden, radios, range } = parts(container);
    expect(hidden.name).toBe("plan");
    expect(hidden.value).toBe("p1");
    expect(radios[0]?.checked).toBe(true);
    expect(range.value).toBe("0");
  });

  it("uses defaultId", () => {
    const { container } = renderKit(
      <PlanPicker name="plan" legend="Plan" plans={plans} defaultId="p3" />,
    );
    const { hidden, radios, range } = parts(container);
    expect(hidden.value).toBe("p3");
    expect(radios[2]?.checked).toBe(true);
    expect(range.value).toBe("2");
  });

  it("a click on a radio changes hidden value, range and calls onChange", () => {
    const onChange = vi.fn();
    const { container } = renderKit(
      <PlanPicker name="plan" legend="Plan" plans={plans} onChange={onChange} />,
    );
    fireEvent.click(parts(container).radios[1] as HTMLInputElement);
    const after = parts(container);
    expect(after.hidden.value).toBe("p2");
    expect(after.range.value).toBe("1");
    expect(after.radios[1]?.checked).toBe(true);
    expect(onChange).toHaveBeenCalledWith("p2");
  });

  it("the range selects a plan and checks its radio", () => {
    const onChange = vi.fn();
    const { container } = renderKit(
      <PlanPicker name="plan" legend="Plan" plans={plans} onChange={onChange} />,
    );
    fireEvent.change(parts(container).range, { target: { value: "2" } });
    const after = parts(container);
    expect(after.hidden.value).toBe("p3");
    expect(after.radios[2]?.checked).toBe(true);
    expect(onChange).toHaveBeenCalledWith("p3");
  });

  it("a controlled value wins and ignores clicks until the parent updates", () => {
    const onChange = vi.fn();
    let setParent: (id: string) => void = () => undefined;
    function Parent() {
      const [id, setId] = useState("p2");
      setParent = setId;
      return <PlanPicker name="plan" legend="Plan" plans={plans} value={id} onChange={onChange} />;
    }
    const { container } = renderKit(<Parent />);
    fireEvent.click(parts(container).radios[2] as HTMLInputElement);
    expect(onChange).toHaveBeenCalledWith("p3");
    expect(parts(container).hidden.value).toBe("p2");
    expect(parts(container).radios[1]?.checked).toBe(true);
    expect(parts(container).radios[2]?.checked).toBe(false);
    act(() => setParent("p3"));
    expect(parts(container).hidden.value).toBe("p3");
    expect(parts(container).radios[2]?.checked).toBe(true);
  });

  it("the radios are one native group, so arrow keys work", () => {
    const { container } = renderKit(<PlanPicker name="plan" legend="Plan" plans={plans} />);
    const names = new Set(parts(container).radios.map((r) => r.name));
    expect(names.size).toBe(1);
    for (const r of parts(container).radios) {
      expect(container.querySelector(`label[for="${r.id}"].tc-plan-card`)).not.toBeNull();
    }
  });

  it("gives the plan name and the rounded-up price as aria-valuetext", () => {
    const { container } = renderKit(
      <PlanPicker name="plan" legend="Plan" plans={plans} defaultId="p2" />,
      { locale: "en" },
    );
    expect(parts(container).range.getAttribute("aria-valuetext")).toBe("Micro, ৳1,235");
  });

  it("shows the price with the period in each card", () => {
    const { container } = renderKit(<PlanPicker name="plan" legend="Plan" plans={plans} />, {
      locale: "en",
    });
    const card = container.querySelector("label.tc-plan-card") as HTMLElement;
    expect(card.classList.contains("bg-seccolorstyle")).toBe(true);
    expect(card.classList.contains("noshadow")).toBe(true);
    expect(card.textContent).toContain("Nano");
    expect(card.textContent).toContain("1 vCPU");
    expect(card.textContent).toContain("৳500");
    expect(card.textContent).toContain("/ 30 days");
  });

  it("shows a message and no input for zero plans", () => {
    const { container } = renderKit(<PlanPicker name="plan" legend="Plan" plans={[]} />, {
      locale: "en",
    });
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("No plans available");
  });

  it("throws for a duplicate id, a non-bigint price and an unknown selection", () => {
    const dup = [plans[0] as PickerPlan, { ...(plans[1] as PickerPlan), id: "p1" }];
    expect(() => renderKit(<PlanPicker name="plan" legend="Plan" plans={dup} />)).toThrow();
    const bad = [{ ...(plans[0] as PickerPlan), priceMinor: 5 as unknown as bigint }];
    expect(() => renderKit(<PlanPicker name="plan" legend="Plan" plans={bad} />)).toThrow(
      TypeError,
    );
    expect(() =>
      renderKit(<PlanPicker name="plan" legend="Plan" plans={plans} defaultId="zz" />),
    ).toThrow(RangeError);
  });

  it("has no style attribute in server markup", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(ssr(<PlanPicker name="plan" legend="Plan" plans={plans} />, { locale })).not.toContain(
        " style=",
      );
    }
  });
});
