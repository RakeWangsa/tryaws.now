// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { DataTable, type DataTableProps } from "./DataTable";
import type { LinkComponent } from "./types";

interface Row {
  id: string;
  name: string;
  size: string;
}

const ROWS: Row[] = [
  { id: "a", name: "alpha", size: "1 GB" },
  { id: "b", name: "beta", size: "2 GB" },
  { id: "c", name: "gamma", size: "4 GB" },
];

const PAGING = { bn: "পাতা পরিবর্তন", en: "Pages" } as const;
const PREVIOUS = { bn: "আগের", en: "Previous" } as const;
const NEXT = { bn: "পরের", en: "Next" } as const;
const EMPTY = { bn: "দেখানোর মতো কিছু নেই", en: "Nothing to show" } as const;

const base = (over: Partial<DataTableProps<Row>> = {}): DataTableProps<Row> => ({
  caption: "Servers",
  columns: [
    { key: "name", header: "Name", cell: (r) => r.name },
    { key: "size", header: "Size", cell: (r) => <b>{r.size}</b>, className: "text-end" },
  ],
  rows: ROWS,
  rowKey: (r) => r.id,
  ...over,
});

describe.each(["bn", "en"] as const)("DataTable (%s)", (locale) => {
  it("uses the markup of cart.html", () => {
    const { container } = renderKit(<DataTable {...base()} />, { locale });
    expect(
      container.querySelector("div.table-responsive-lg > table.table.compare.tc-datatable"),
    ).not.toBeNull();
    const caption = container.querySelector("table > caption");
    expect(caption?.textContent).toBe("Servers");
    expect(caption?.classList.contains("visually-hidden")).toBe(true);
    expect(container.querySelector("thead > tr.seccolor")).not.toBeNull();
    expect(container.querySelector("tbody > tr.seccolor")).not.toBeNull();
    expect(unknownClasses(container)).toEqual([]);
  });

  it("header cells have scope=col and every td carries its column header as data-label", () => {
    const { container } = renderKit(<DataTable {...base()} />, { locale });
    const heads = [...container.querySelectorAll("thead th")];
    expect(heads.map((h) => h.textContent)).toEqual(["Name", "Size"]);
    expect(heads.every((h) => h.getAttribute("scope") === "col")).toBe(true);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const cells = [...row.querySelectorAll("td")];
      expect(cells.map((c) => c.getAttribute("data-label"))).toEqual(["Name", "Size"]);
    }
    expect(rows[1]?.querySelectorAll("td")[1]?.innerHTML).toBe("<b>2 GB</b>");
    expect(rows[1]?.querySelectorAll("td")[1]?.classList.contains("text-end")).toBe(true);
  });

  it("calls rowKey once per row and the cell function with the row", () => {
    const rowKey = vi.fn((r: Row) => r.id);
    const cell = vi.fn((r: Row) => r.name);
    renderKit(
      <DataTable {...base({ rowKey, columns: [{ key: "name", header: "Name", cell }] })} />,
      { locale },
    );
    expect(rowKey).toHaveBeenCalledTimes(3);
    expect(cell.mock.calls.map((c) => c[0])).toEqual(ROWS);
  });

  it("shows the empty text across all columns when there are no rows", () => {
    const { container } = renderKit(<DataTable {...base({ rows: [] })} />, { locale });
    const cells = container.querySelectorAll("tbody td");
    expect(cells).toHaveLength(1);
    expect(cells[0]?.textContent).toBe(EMPTY[locale]);
    expect(cells[0]?.getAttribute("colspan")).toBe("2");
  });

  it("both hrefs give two links; labels come from the messages", () => {
    const { container } = renderKit(
      <DataTable {...base({ prevHref: "?cursor=p", nextHref: "?cursor=n" })} />,
      { locale },
    );
    const nav = container.querySelector("nav.tc-datatable-paging");
    expect(nav?.getAttribute("aria-label")).toBe(PAGING[locale]);
    const links = [...(nav?.querySelectorAll("a.btn.btn-sm.btn-default-fill") ?? [])];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["?cursor=p", "?cursor=n"]);
    expect(links.map((a) => a.textContent)).toEqual([PREVIOUS[locale], NEXT[locale]]);
    expect(nav?.parentElement).toBe(container);
    expect(unknownClasses(container)).toEqual([]);
  });

  it("a null href gives a disabled button and the other side stays a link", () => {
    const { container } = renderKit(<DataTable {...base({ prevHref: null, nextHref: "?c=n" })} />, {
      locale,
    });
    const nav = container.querySelector("nav") as HTMLElement;
    const button = nav.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe(PREVIOUS[locale]);
    expect(button.className).toContain("btn btn-default-fill btn-sm");
    expect(nav.querySelectorAll("a")).toHaveLength(1);
    expect(nav.querySelector("a")?.getAttribute("href")).toBe("?c=n");
  });

  it("an undefined side is disabled while the other is a string", () => {
    const { container } = renderKit(<DataTable {...base({ prevHref: "?c=p" })} />, { locale });
    const nav = container.querySelector("nav") as HTMLElement;
    expect((nav.querySelector("button") as HTMLButtonElement).textContent).toBe(NEXT[locale]);
  });

  it("omits the nav when both hrefs are undefined", () => {
    const { container } = renderKit(<DataTable {...base()} />, { locale });
    expect(container.querySelector("nav")).toBeNull();
  });

  it("uses linkAs for the links", () => {
    const Custom: LinkComponent = ({ href, className, children }) => (
      <a href={href} className={className} data-custom="1">
        {children}
      </a>
    );
    const { container } = renderKit(
      <DataTable {...base({ prevHref: "?a", nextHref: "?b", linkAs: Custom })} />,
      { locale },
    );
    expect(container.querySelectorAll("nav a[data-custom='1']")).toHaveLength(2);
  });

  it("server HTML has no inline style", () => {
    const html = ssr(<DataTable {...base({ prevHref: null, nextHref: "?n" })} />, { locale });
    expect(html).not.toContain(" style=");
    expect(unknownClasses(html)).toEqual([]);
  });

  it("an extra className lands on the table wrapper table", () => {
    const { container } = renderKit(<DataTable {...base({ className: "mb-4" })} />, { locale });
    expect(container.querySelector("table")?.classList.contains("mb-4")).toBe(true);
  });
});
