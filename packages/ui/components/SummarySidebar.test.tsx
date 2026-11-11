// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { MoneyText } from "./MoneyText";
import { SummarySidebar } from "./SummarySidebar";

const rows = [
  { label: "Subtotal", value: <MoneyText minor={123450n} /> },
  { label: "VAT", value: <MoneyText minor={0n} /> },
  { label: "Total", value: <MoneyText minor={123450n} />, strong: true },
];
const action = <button type="button">Pay now</button>;

function base() {
  return (
    <SummarySidebar
      title="Order summary"
      planTitle="Selected plan"
      planLines={["2 vCPU", "4 GB memory"]}
      rows={rows}
      action={action}
    />
  );
}

describe("SummarySidebar", () => {
  it("is an aside with the sidebar classes and no id (the AppShell owns #sidebar)", () => {
    const { container } = renderKit(base());
    const aside = container.querySelector("aside") as HTMLElement;
    for (const name of ["sidebar", "sec-bg1", "bg-seccolorstyle", "noshadow", "tc-summary"]) {
      expect(aside.classList.contains(name), name).toBe(true);
    }
    expect(aside.hasAttribute("id")).toBe(false);
    expect(container.querySelector("[id]")).toBeNull();
  });

  it("has a full block and a bar block", () => {
    const { container } = renderKit(base());
    const full = container.querySelector("aside > div.tc-summary-full") as HTMLElement;
    const bar = container.querySelector("aside > div.tc-summary-bar") as HTMLElement;
    expect(full.classList.contains("d-none")).toBe(true);
    expect(full.classList.contains("d-lg-block")).toBe(true);
    expect(bar.classList.contains("d-lg-none")).toBe(true);
  });

  it("shows every row label once in the full block and once in the details of the bar", () => {
    const { container } = renderKit(base(), { locale: "en" });
    const full = container.querySelector(".tc-summary-full") as HTMLElement;
    const more = container.querySelector(".tc-summary-bar details.tc-summary-more") as HTMLElement;
    for (const row of rows) {
      const count = (root: HTMLElement) =>
        [...root.querySelectorAll(".title-table")].filter((el) => el.textContent === row.label)
          .length;
      expect(count(full), `${row.label} in full`).toBe(1);
      expect(count(more), `${row.label} in details`).toBe(1);
    }
  });

  it("builds the order summary table of the mockup", () => {
    const { container } = renderKit(base(), { locale: "en" });
    const summary = container.querySelector(".tc-summary-full div.ordersummary") as HTMLElement;
    expect(summary.classList.contains("mb-5")).toBe(true);
    const heading = summary.firstElementChild as HTMLElement;
    expect(heading.className).toBe("mergecolor h4 mb-3");
    expect(heading.textContent).toBe("Order summary");
    const trs = summary.querySelectorAll(
      "div.table-responsive-lg > table.table > tbody > tr.seccolor",
    );
    expect(trs.length).toBe(3);
    expect(trs[0]?.querySelector("td > div.title-table")?.textContent).toBe("Subtotal");
    expect(trs[0]?.querySelectorAll("td")[1]?.textContent).toBe("৳1,234.50");
  });

  it("renders the value of a strong row in <b> in the full block", () => {
    const { container } = renderKit(base(), { locale: "en" });
    const full = container.querySelector(".tc-summary-full") as HTMLElement;
    const bolds = full.querySelectorAll("tbody b");
    expect(bolds.length).toBe(1);
    expect(bolds[0]?.textContent).toBe("৳1,234.50");
    expect(full.querySelectorAll("tbody tr")[0]?.querySelector("b")).toBeNull();
  });

  it("puts the action in both blocks", () => {
    const { container } = renderKit(base());
    expect(container.querySelector(".tc-summary-full button")?.textContent).toBe("Pay now");
    expect(container.querySelector(".tc-summary-bar > div button")?.textContent).toBe("Pay now");
    expect(container.querySelectorAll("button").length).toBe(2);
  });

  it("opens the bar with a native details whose summary says Details / বিস্তারিত", () => {
    const en = renderKit(base(), { locale: "en" });
    expect(en.container.querySelector("details.tc-summary-more > summary")?.textContent).toBe(
      "Details",
    );
    en.unmount();
    const bn = renderKit(base(), { locale: "bn" });
    expect(bn.container.querySelector("details.tc-summary-more > summary")?.textContent).toBe(
      "বিস্তারিত",
    );
  });

  it("shows the last strong row (label and value) beside the action in the bar", () => {
    const { container } = renderKit(base(), { locale: "en" });
    const line = container.querySelector(
      ".tc-summary-bar > div:not(.tc-summary-more)",
    ) as HTMLElement;
    expect(line.textContent).toContain("Total");
    expect(line.textContent).toContain("৳1,234.50");
    expect(line.textContent).toContain("Pay now");
  });

  it("puts the spacer after the aside", () => {
    const { container } = renderKit(base());
    const aside = container.querySelector("aside") as HTMLElement;
    const spacer = aside.nextElementSibling as HTMLElement;
    expect(spacer.classList.contains("tc-summary-spacer")).toBe(true);
    expect(spacer.classList.contains("d-lg-none")).toBe(true);
  });

  it("renders the included list in the full block only, one ul per line", () => {
    const { container } = renderKit(base());
    expect(container.querySelectorAll(".included").length).toBe(1);
    expect(container.querySelector(".tc-summary-full .included")).not.toBeNull();
    const items = container.querySelectorAll(".included ul > li.seccolor");
    expect([...items].map((li) => li.textContent?.trim())).toEqual(["2 vCPU", "4 GB memory"]);
    const icon = items[0]?.querySelector("i.fas.fa-check-circle") as HTMLElement;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".included .h4")?.textContent).toBe("Selected plan");
  });

  it("has no .included without planLines", () => {
    const { container } = renderKit(
      <SummarySidebar title="Order summary" rows={rows} action={action} />,
    );
    expect(container.querySelector(".included")).toBeNull();
  });

  it("has no summary line in the bar without a strong row", () => {
    const { container } = renderKit(
      <SummarySidebar title="Order summary" rows={rows.slice(0, 2)} action={action} />,
    );
    expect(container.querySelectorAll("tbody b").length).toBe(0);
    expect(container.querySelector(".tc-summary-bar > div button")?.textContent).toBe("Pay now");
  });

  it("uses only known classes and no inline style", () => {
    const { container } = renderKit(base());
    expect(unknownClasses(container)).toEqual([]);
    expect(ssr(base())).not.toContain(" style=");
  });

  it("renders in bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      const { container, unmount } = renderKit(base(), { locale });
      expect(container.querySelector("aside")).not.toBeNull();
      unmount();
    }
  });
});
