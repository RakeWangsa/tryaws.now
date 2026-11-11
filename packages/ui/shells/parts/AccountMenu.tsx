"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactElement, ReactNode } from "react";

export interface AccountMenuProps {
  /** The accessible name of the trigger. */
  label: string;
  name: string;
  detail?: string;
  items: readonly { href: string; label: string }[];
  /** The last entry, supplied by the app (the sign-out form). */
  footer?: ReactNode;
}

/**
 * The account dropdown of the top bar on a Radix DropdownMenu: arrow keys, Escape and focus return
 * come from Radix; the look comes from the Bootstrap `dropdown-menu` classes of the theme.
 */
export function AccountMenu({
  label,
  name,
  detail,
  items,
  footer,
}: AccountMenuProps): ReactElement {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="btn btn-link mergecolor p-0" aria-label={label}>
          <i className="fas fa-circle-user fa-lg" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-menu show tc-account-menu"
          align="end"
          sideOffset={8}
        >
          <DropdownMenu.Label className="dropdown-header">
            <span className="d-block mergecolor">{name}</span>
            {detail !== undefined && <span className="d-block small">{detail}</span>}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="dropdown-divider" />
          {items.map((item) => (
            <DropdownMenu.Item key={item.href} asChild>
              <a className="dropdown-item" href={item.href}>
                {item.label}
              </a>
            </DropdownMenu.Item>
          ))}
          {footer !== undefined && (
            <>
              <DropdownMenu.Separator className="dropdown-divider" />
              <DropdownMenu.Item asChild>
                <div
                  className="dropdown-item-text"
                  onClick={(event) => {
                    // Enter on the item (Radix clicks it) reaches the control inside the slot.
                    if (event.target === event.currentTarget) {
                      event.currentTarget.querySelector<HTMLElement>("button, a")?.click();
                    }
                  }}
                >
                  {footer}
                </div>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
