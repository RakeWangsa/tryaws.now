"use client";

import { useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

const MENU_ID = "mobile-main-menu";

/**
 * The mobile bar of the mockup. It replaces the toggle of the theme's script: the `active` class goes
 * on the wrapper and on the button, Escape closes the menu and returns focus to the button.
 */
export function MobileMenu({
  label,
  brand,
  children,
}: {
  label: string;
  /** The logo link of the bar, left of the toggle (optional, the mockup has it). */
  brand?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const active = open ? " active" : "";

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && open) {
      setOpen(false);
      button.current?.focus();
    }
  }

  return (
    <div className={`menu-wrap mobile${active}`} onKeyDown={onKeyDown}>
      <div className="container">
        <div className="row align-items-center">
          <div className="col-6">{brand}</div>
          <div className="col-6">
            <nav className="nav-menu float-end d-flex">
              <button
                ref={button}
                type="button"
                id="nav-toggle"
                className={`menu-toggle${active}`}
                aria-label={label}
                aria-expanded={open}
                aria-controls={MENU_ID}
                onClick={() => setOpen((value) => !value)}
              >
                <span className="icon"></span>
                <span className="icon"></span>
                <span className="icon"></span>
              </button>
              <div id={MENU_ID} className="main-menu bg-seccolorstyle">
                {children}
              </div>
            </nav>
          </div>
        </div>
      </div>
    </div>
  );
}
