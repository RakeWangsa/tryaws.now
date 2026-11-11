"use client";

import * as RadixToast from "@radix-ui/react-toast";
import { useTranslations } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

export type ToastTone = "success" | "info" | "warning" | "danger";

export interface ToastInput {
  title?: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
}

export interface ToastApi {
  show(toast: ToastInput): void;
}

const ICON: Record<ToastTone, string> = {
  success: "fas fa-check-circle",
  info: "fas fa-info-circle",
  warning: "fas fa-exclamation-triangle",
  danger: "fas fa-times-circle",
};

const DEFAULT_DURATION_MS = 5000;

interface Entry extends ToastInput {
  id: number;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Shows a toast. Throws outside a `ToastProvider`: a missing provider is a defect (R16). */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error("useToast must be used inside a ToastProvider");
  return api;
}

export interface ToastProviderProps {
  children?: ReactNode;
}

/**
 * Radix Toast with the Bootstrap toast markup. The viewport mounts after the first client effect:
 * Radix writes an inline `style` on it, which must not be in server HTML (U4).
 */
export function ToastProvider({ children }: ToastProviderProps) {
  const t = useTranslations("kit.toast");
  const common = useTranslations("kit.common");
  const [mounted, setMounted] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  const show = useCallback((toast: ToastInput): void => {
    if (toast.title === undefined && toast.description === undefined) {
      throw new RangeError("show: a toast needs a title or a description");
    }
    nextId.current += 1;
    const id = nextId.current;
    setEntries((current) => [...current, { ...toast, id }]);
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);
  const remove = (id: number): void => setEntries((current) => current.filter((e) => e.id !== id));

  return (
    <ToastContext.Provider value={api}>
      <RadixToast.Provider duration={DEFAULT_DURATION_MS} swipeDirection="right">
        {children}
        {entries.map((entry) => {
          const tone = entry.tone ?? "info";
          return (
            <RadixToast.Root
              key={entry.id}
              className="toast show"
              duration={entry.durationMs ?? DEFAULT_DURATION_MS}
              onOpenChange={(open) => {
                if (!open) remove(entry.id);
              }}
            >
              <div className="toast-header">
                <i className={`${ICON[tone]} text-${tone} me-2`} aria-hidden="true" />
                <strong className="me-auto">{t(tone)}</strong>
                <RadixToast.Close className="btn-close" aria-label={common("close")} />
              </div>
              <div className="toast-body">
                {entry.title !== undefined && <strong className="d-block">{entry.title}</strong>}
                {entry.description}
              </div>
            </RadixToast.Root>
          );
        })}
        {mounted && (
          <RadixToast.Viewport
            label={t("region")}
            className="toast-container position-fixed bottom-0 end-0 p-3 list-unstyled tc-toast-viewport"
          />
        )}
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}
