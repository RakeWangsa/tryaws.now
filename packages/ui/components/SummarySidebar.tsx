import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export interface SummaryRow {
  label: string;
  value: ReactNode;
  /** The total row: its value is bold, and the bar shows it beside the action. */
  strong?: boolean;
}

export interface SummarySidebarProps {
  title: string;
  planTitle?: string;
  planLines?: string[];
  rows: SummaryRow[];
  action: ReactNode;
}

function RowsTable({ rows }: { rows: SummaryRow[] }) {
  return (
    <div className="table-responsive-lg">
      <table className="table">
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${index}:${row.label}`} className="seccolor">
              <td>
                <div className="title-table">{row.label}</div>
              </td>
              <td>{row.strong ? <b>{row.value}</b> : row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The order summary of configurator.html and cart.html. On a wide screen it is the sidebar; below
 * 992 px the theme classes hide it and show a fixed bar with the total and the action (6.3). The
 * rows are in the DOM twice and the hidden copy is `display: none`. The AppShell owns `#sidebar`,
 * so this aside has no id.
 */
export function SummarySidebar({ title, planTitle, planLines, rows, action }: SummarySidebarProps) {
  const t = useTranslations("kit.summary");
  const strongRow = [...rows].reverse().find((row) => row.strong === true);
  return (
    <>
      <aside className="sidebar sec-bg1 bg-seccolorstyle noshadow tc-summary">
        <div className="tc-summary-full d-none d-lg-block">
          {planLines && planLines.length > 0 ? (
            <div className="included c-grey mt-0">
              {planTitle ? <div className="mergecolor h4 mb-3">{planTitle}</div> : null}
              {planLines.map((line, index) => (
                <ul key={`${index}:${line}`}>
                  <li className="seccolor">
                    <i className="fas fa-check-circle me-1" aria-hidden="true" /> {line}
                  </li>
                </ul>
              ))}
            </div>
          ) : null}
          <div className="ordersummary mb-5">
            <div className="mergecolor h4 mb-3">{title}</div>
            <RowsTable rows={rows} />
          </div>
          {action}
        </div>
        <div className="tc-summary-bar d-lg-none">
          <details className="tc-summary-more">
            <summary>{t("details")}</summary>
            <RowsTable rows={rows} />
          </details>
          <div className="d-flex align-items-center justify-content-between gap-3">
            {strongRow ? (
              <div className="seccolor">
                <div className="title-table">{strongRow.label}</div>
                <b>{strongRow.value}</b>
              </div>
            ) : null}
            {action}
          </div>
        </div>
      </aside>
      <div className="tc-summary-spacer d-lg-none" />
    </>
  );
}
