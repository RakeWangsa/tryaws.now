"use client";

import * as Dialog from "@radix-ui/react-dialog";
import type { ReactElement, ReactNode } from "react";

export interface NavDrawerProps {
  openLabel: string;
  closeLabel: string;
  /** The heading of the open drawer; the open label when omitted. */
  title?: string;
  children: ReactNode;
}

/**
 * The offcanvas of header.html (`div#offcanvasWithBackdrop`) on a Radix Dialog: focus trap, Escape
 * and focus return come from Radix, the look from the theme classes. Closed, nothing but the
 * trigger is in the markup, so the server HTML has no inline style.
 */
export function NavDrawer({
  openLabel,
  closeLabel,
  title,
  children,
}: NavDrawerProps): ReactElement {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="btn btn-link d-lg-none p-0 me-3" aria-label={openLabel}>
          <i className="fas fa-bars" aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="offcanvas-backdrop fade show" />
        <Dialog.Content
          className="offcanvas offcanvas-start offcanvas-box bg-colorstyle show"
          aria-describedby={undefined}
        >
          <div className="offcanvas-header">
            <Dialog.Title asChild>
              <h5 className="offcanvas-title mergecolor">{title ?? openLabel}</h5>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="btn-close text-reset" aria-label={closeLabel} />
            </Dialog.Close>
          </div>
          <div className="offcanvas-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
