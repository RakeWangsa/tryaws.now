import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { cx } from "./cx";
import type { LinkComponent } from "./types";

export interface DataTableColumn<Row> {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  className?: string;
}

export interface DataTableProps<Row> {
  /** Names the table for assistive technology; not shown. */
  caption: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Cursor paging: a link when a string, a disabled control when `null`. */
  prevHref?: string | null;
  nextHref?: string | null;
  linkAs?: LinkComponent;
  className?: string;
}

/**
 * The table of cart.html (`table.table.compare` in `div.table-responsive-lg`) with cursor paging.
 * Below 768 px each row is a card (tc.css, 5.5); `data-label` carries the column header.
 */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  prevHref,
  nextHref,
  linkAs,
  className,
}: DataTableProps<Row>) {
  const t = useTranslations("kit.dataTable");
  const keyed = rows.map((row) => ({ row, key: rowKey(row) }));
  const paged = prevHref !== undefined || nextHref !== undefined;
  const link = (href: string | null | undefined, label: string): ReactNode => {
    const props = { variant: "default", size: "sm" } as const;
    if (typeof href === "string") {
      return (
        <Button {...props} href={href} {...(linkAs ? { as: linkAs } : {})}>
          {label}
        </Button>
      );
    }
    return (
      <Button {...props} disabled>
        {label}
      </Button>
    );
  };

  return (
    <>
      <div className="table-responsive-lg">
        <table className={cx("table compare tc-datatable", className)}>
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr className="seccolor">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cx("title mergecolor border-start-0", column.className)}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keyed.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>{t("empty")}</td>
              </tr>
            ) : (
              keyed.map(({ row, key }) => (
                <tr key={key} className="seccolor">
                  {columns.map((column) => (
                    <td key={column.key} data-label={column.header} className={column.className}>
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {paged && (
        <nav
          className="tc-datatable-paging d-flex justify-content-between mt-3"
          aria-label={t("paging")}
        >
          {link(prevHref, t("previous"))}
          {link(nextHref, t("next"))}
        </nav>
      )}
    </>
  );
}
