"use client";

import { useState, type ReactElement } from "react";
import { Button } from "../components/Button.tsx";
import { ConfirmDestroy } from "../components/ConfirmDestroy.tsx";
import { ToastProvider, useToast, type ToastTone } from "../components/Toast.tsx";

// The two demos that need state: a controlled dialog and toasts. Every text comes in as a prop,
// already translated by the section that renders them.

export function ConfirmDestroyDemo({
  trigger,
  resourceName,
  title,
  description,
}: {
  trigger: string;
  resourceName: string;
  title: string;
  description: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        {trigger}
      </Button>
      <ConfirmDestroy
        open={open}
        onOpenChange={setOpen}
        resourceName={resourceName}
        title={title}
        description={description}
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}

export interface ToastDemoItem {
  tone: ToastTone;
  label: string;
}

function ToastButtons({
  items,
  title,
  description,
}: {
  items: readonly ToastDemoItem[];
  title: string;
  description: string;
}): ReactElement {
  const toast = useToast();
  return (
    <div className="d-flex flex-wrap gap-2">
      {items.map((item) => (
        <Button
          key={item.tone}
          size="sm"
          variant="tertiary"
          onClick={() => toast.show({ tone: item.tone, title, description })}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}

export function ToastDemo(props: {
  items: readonly ToastDemoItem[];
  title: string;
  description: string;
}): ReactElement {
  return (
    <ToastProvider>
      <ToastButtons {...props} />
    </ToastProvider>
  );
}
