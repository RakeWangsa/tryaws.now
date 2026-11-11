// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { PlanCard, type PlanCardProps } from "./PlanCard";

const specs: PlanCardProps["specs"] = [
  { icon: "icon-cpu", label: "CPU", value: "2 vCPU" },
  { icon: "icon-ram", label: "RAM", value: "4 GB" },
  { icon: "icon-drivessd", label: "SSD", value: "80 GB" },
  { icon: "icon-speed", label: "Data", value: "4 TB" },
];
const cta = { label: "Choose", href: "/plans/p1" };

describe("PlanCard", () => {
  it("shows the price rounded up to whole taka in en, then the period", () => {
    const { container } = renderKit(
      <PlanCard name="Nano" priceMinor={123450n} specs={specs} cta={cta} />,
      { locale: "en" },
    );
    const price = container.querySelector(".price.seccolor") as HTMLElement;
    expect(price.textContent).toBe("৳1,235 / 30 days");
    expect(price.querySelector("span.period")?.textContent).toBe("/ 30 days");
  });

  it("shows Bengali numerals in bn", () => {
    const { container } = renderKit(
      <PlanCard name="Nano" priceMinor={123450n} specs={specs} cta={cta} />,
      { locale: "bn" },
    );
    const price = container.querySelector(".price") as HTMLElement;
    expect(price.textContent).toBe("৳১,২৩৫ / ৩০ দিন");
  });

  it("has the markup of the mockup (index.html, pricing)", () => {
    const { container } = renderKit(
      <PlanCard name="Nano" priceMinor={50000n} specs={specs} cta={cta} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect([...root.classList]).toEqual(["wrapper"]);
    const top = root.querySelector(":scope > .top-content") as HTMLElement;
    expect([...top.classList]).toEqual(["top-content", "bg-seccolorstyle", "topradius"]);
    expect(top.querySelector(".title")?.textContent).toBe("Nano");
    const list = root.querySelector(":scope > ul.list-info.bg-purple") as HTMLElement;
    expect(list.querySelectorAll(":scope > li")).toHaveLength(4);
    const first = list.querySelector("li") as HTMLElement;
    expect(first.querySelector("i")?.className).toBe("icon-cpu");
    expect(first.querySelector("span.f-14")?.textContent).toBe("CPU");
    expect(first.querySelector("br")).not.toBeNull();
    expect(first.textContent).toContain("2 vCPU");
    for (const icon of list.querySelectorAll("i")) {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
    expect(root.querySelector(".badge")).toBeNull();
    expect(unknownClasses(container)).toEqual([]);
  });

  it("shows the recommended badge before the content", () => {
    const { container } = renderKit(
      <PlanCard name="Nano" priceMinor={50000n} specs={specs} cta={cta} recommended />,
      { locale: "en" },
    );
    const badge = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement;
    expect([...badge.classList]).toEqual(["plans", "badge", "feat", "bg-dark"]);
    expect(badge.textContent).toBe("Recommended");
  });

  it("renders the call to action as a primary link", () => {
    const { container } = renderKit(
      <PlanCard name="Nano" priceMinor={50000n} specs={specs} cta={cta} />,
    );
    const a = container.querySelector("a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("/plans/p1");
    expect(a.classList.contains("btn-default-yellow-fill")).toBe(true);
    expect(a.textContent).toBe("Choose");
  });

  it("throws TypeError for a number price", () => {
    expect(() =>
      renderKit(
        <PlanCard name="Nano" priceMinor={500 as unknown as bigint} specs={specs} cta={cta} />,
      ),
    ).toThrow(TypeError);
  });

  it("does not accept three specs", () => {
    const three = specs.slice(0, 3);
    // @ts-expect-error a card has exactly four specs
    const element = <PlanCard name="Nano" priceMinor={1n} specs={three} cta={cta} />;
    expect(element).toBeDefined();
  });

  it("has no style attribute in bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(
        ssr(<PlanCard name="Nano" priceMinor={50000n} specs={specs} cta={cta} recommended />, {
          locale,
        }),
      ).not.toContain(" style=");
    }
  });
});
