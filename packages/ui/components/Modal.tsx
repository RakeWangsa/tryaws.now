"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export interface ModalProps {
  /** Given: the caller controls the dialog. Omitted: the dialog opens from `trigger`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: string;
  description?: string;
  footer?: ReactNode;
  children?: ReactNode;
}

/**
 * The Bootstrap modal markup of the mockup (cart.html) on a Radix Dialog: focus trap, Escape,
 * focus return and a click on the dimmed area come from Radix; the look comes from the theme.
 * `tc-modal-open` shows the theme's `display: none` modal without a script (tc.css, 5.4).
 */
export function Modal({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  footer,
  children,
}: ModalProps) {
  const t = useTranslations("kit.common");
  const rootProps = open === undefined ? {} : { open };
  return (
    <Dialog.Root {...rootProps} {...(onOpenChange ? { onOpenChange } : {})}>
      {trigger !== undefined && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop fade show" />
        <div className="modal fade show tc-modal-open">
          <Dialog.Content
            className="modal-dialog"
            {...(description === undefined ? { "aria-describedby": undefined } : {})}
          >
            <div className="modal-content">
              <div className="modal-header">
                <Dialog.Title asChild>
                  <h5 className="modal-title">{title}</h5>
                </Dialog.Title>
                <Dialog.Close asChild>
                  <button type="button" className="btn-close" aria-label={t("close")} />
                </Dialog.Close>
              </div>
              <div className="modal-body">
                {description !== undefined && (
                  <Dialog.Description asChild>
                    <p className="mb-0">{description}</p>
                  </Dialog.Description>
                )}
                {children}
              </div>
              <div className="modal-footer">{footer}</div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
