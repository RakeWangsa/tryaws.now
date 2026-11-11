"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Button } from "./Button";
import { Field, FormBlock } from "./Field";
import { Modal } from "./Modal";

export interface ConfirmDestroyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The name the customer must type, exactly. */
  resourceName: string;
  title: string;
  description: string;
  onConfirm: () => void | Promise<void>;
  /** True while the caller's action runs: both buttons are inert (U8). */
  pending?: boolean;
}

interface BodyProps {
  resourceName: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  pending: boolean;
}

/** Input and buttons. It lives inside the dialog content, so closing the dialog clears the input. */
function ConfirmBody({ resourceName, onCancel, onConfirm, pending }: BodyProps) {
  const t = useTranslations("kit.confirmDestroy");
  const common = useTranslations("kit.common");
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const running = useRef(false);
  const matches = typed === resourceName;
  const busy = pending || submitting;

  const run = async (): Promise<void> => {
    if (!matches || running.current) return;
    running.current = true;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      running.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
      <FormBlock>
        <Field
          name="confirm-name"
          label={t("typeName", { name: resourceName })}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className="mt-3"
        />
      </FormBlock>
      <div className="d-flex justify-content-end gap-2">
        <Button variant="default" disabled={busy} onClick={onCancel}>
          {common("cancel")}
        </Button>
        <Button variant="destructive" disabled={!matches} pending={busy} onClick={() => void run()}>
          {t("confirm")}
        </Button>
      </div>
    </>
  );
}

/**
 * U10: the customer types the resource name before a destructive action. This is half of the
 * control; the fresh sign-in check and R13 are server work.
 */
export function ConfirmDestroy({
  open,
  onOpenChange,
  resourceName,
  title,
  description,
  onConfirm,
  pending = false,
}: ConfirmDestroyProps) {
  if (resourceName === "") {
    throw new RangeError("ConfirmDestroy: resourceName must not be empty");
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <ConfirmBody
        resourceName={resourceName}
        pending={pending}
        onCancel={() => onOpenChange(false)}
        onConfirm={onConfirm}
      />
    </Modal>
  );
}
