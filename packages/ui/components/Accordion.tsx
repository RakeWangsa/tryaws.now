"use client";

import { useId, useState, type ReactNode } from "react";
import { cx } from "./cx";

export type AccordionProps = {
  items: { id: string; title: string; content: ReactNode }[];
  defaultOpenId?: string;
  headingLevel?: 2 | 3 | 4;
  className?: string;
};

/**
 * The FAQ accordion of the theme (elements.html) as a disclosure: a heading holds a button, the
 * button controls a region. One item is open at a time; clicking the open one closes it. The
 * theme opens panels with a script; here the class `active` on the title and the `hidden`
 * attribute on the region carry the state (CSS 5.3), so the server HTML is already correct.
 */
export function Accordion({ items, defaultOpenId, headingLevel = 3, className }: AccordionProps) {
  const uid = useId();
  if (defaultOpenId !== undefined && !items.some((item) => item.id === defaultOpenId)) {
    throw new RangeError(
      `Accordion: defaultOpenId ${JSON.stringify(defaultOpenId)} is not an item id`,
    );
  }
  const [openId, setOpenId] = useState<string | null>(defaultOpenId ?? null);
  const Heading = `h${headingLevel}` as const;

  return (
    <div className={cx("accordion faq", className)}>
      {items.map((item) => {
        const open = item.id === openId;
        const buttonId = `acc-${uid}-${item.id}`;
        const regionId = `acc-panel-${uid}-${item.id}`;
        return (
          <div className="panel-wrap" key={item.id}>
            <div className={cx("panel-title mergecolor", open && "active")}>
              <Heading className="tc-accordion-heading">
                <button
                  type="button"
                  className="tc-accordion-trigger"
                  id={buttonId}
                  aria-expanded={open}
                  aria-controls={regionId}
                  onClick={() => setOpenId(open ? null : item.id)}
                >
                  <span>{item.title}</span>
                  <div className="float-end">
                    <i className="fa fa-plus" aria-hidden="true" />
                    <i className="fa fa-minus c-pink" aria-hidden="true" />
                  </div>
                </button>
              </Heading>
            </div>
            <div
              className="panel-collapse tc-accordion-panel"
              id={regionId}
              role="region"
              aria-labelledby={buttonId}
              hidden={!open}
            >
              <div className="wrapper-collapse tc-accordion-body">
                <div className="info seccolor">{item.content}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
