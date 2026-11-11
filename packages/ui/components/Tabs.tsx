"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

export type TabsProps = {
  /** The accessible name of the tab list. Pass a translated string. */
  label: string;
  tabs: { id: string; title: ReactNode; content: ReactNode }[];
  defaultId?: string;
  className?: string;
};

/**
 * Tabs in the markup of the theme (login.html) with the ARIA tabs pattern. Every panel is in the
 * server HTML; the inactive ones are `hidden`. Arrow keys, Home and End move and select (automatic
 * activation). Panels stay mounted, so a typed value survives a switch.
 */
export function Tabs({ label, tabs, defaultId, className }: TabsProps) {
  const uid = useId();
  const first = tabs[0];
  if (first === undefined) throw new RangeError("Tabs needs at least one tab");
  if (defaultId !== undefined && !tabs.some((tab) => tab.id === defaultId)) {
    throw new RangeError(`Tabs: defaultId ${JSON.stringify(defaultId)} is not a tab id`);
  }
  const [selected, setSelected] = useState(defaultId ?? first.id);
  const tabRefs = useRef(new Map<string, HTMLLIElement>());

  const tabId = (id: string): string => `tab-${uid}-${id}`;
  const panelId = (id: string): string => `panel-${uid}-${id}`;

  const select = (index: number, focus: boolean): void => {
    const target = tabs[(index + tabs.length) % tabs.length];
    if (target === undefined) return;
    setSelected(target.id);
    if (focus) tabRefs.current.get(target.id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, index: number): void => {
    switch (event.key) {
      case "ArrowRight":
        select(index + 1, true);
        break;
      case "ArrowLeft":
        select(index - 1, true);
        break;
      case "Home":
        select(0, true);
        break;
      case "End":
        select(tabs.length - 1, true);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className={cx("tabs", className)}>
      <div className="tabs-header btn-select-customer">
        <ul className="btn-group d-block" role="tablist" aria-label={label}>
          {tabs.map((tab, index) => {
            const active = tab.id === selected;
            return (
              <li
                key={tab.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                className={cx("btn btn-secondary mb-2", active && "active")}
                role="tab"
                id={tabId(tab.id)}
                aria-selected={active}
                aria-controls={panelId(tab.id)}
                tabIndex={active ? 0 : -1}
                onClick={() => select(index, false)}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                {tab.title}
              </li>
            );
          })}
        </ul>
      </div>
      {tabs.map((tab) => {
        const active = tab.id === selected;
        return (
          <div
            key={tab.id}
            className={cx("table tabs-item", active && "active")}
            role="tabpanel"
            id={panelId(tab.id)}
            aria-labelledby={tabId(tab.id)}
            hidden={!active}
          >
            {tab.content}
          </div>
        );
      })}
    </div>
  );
}
