import type { ReactElement } from "react";
import { cx } from "../../components/cx.ts";
import type { VisibleNavEntry } from "../types.ts";

export interface NavListProps<Id extends string> {
  items: readonly VisibleNavEntry<Id>[];
  currentId: Id;
  labelOf: (id: Id) => string;
  hrefOf: (id: Id) => string;
  soonLabel: string;
}

/**
 * The rows of the left navigation (legal.html, `div.heading.pt-2`). The current row is marked by
 * `aria-current`, the class `active` and a trailing angle icon, so the state is not color alone. A
 * soon entry is text with a badge and no link.
 */
export function NavList<Id extends string>({
  items,
  currentId,
  labelOf,
  hrefOf,
  soonLabel,
}: NavListProps<Id>): ReactElement {
  return (
    <>
      {items.map(({ entry, soon }) => {
        const icon = <i className={cx("fas", entry.icon, "me-3")} aria-hidden="true" />;
        if (soon) {
          return (
            <div key={entry.id} className="heading pt-2">
              <span className="seccolor tc-nav-label" aria-disabled="true">
                {icon}
                <span className="tc-nav-label">{labelOf(entry.id)}</span>
                <span className="badge bg-grey ms-2 tc-nav-label">{soonLabel}</span>
              </span>
            </div>
          );
        }
        const current = entry.id === currentId;
        return (
          <div key={entry.id} className="heading pt-2">
            <a
              href={hrefOf(entry.id)}
              className={cx("seccolor", current && "active")}
              {...(current ? { "aria-current": "page" as const } : {})}
            >
              {icon}
              <span className="tc-nav-label">{labelOf(entry.id)}</span>
              {current && <i className="fas fa-angle-right ms-2" aria-hidden="true" />}
            </a>
          </div>
        );
      })}
    </>
  );
}
