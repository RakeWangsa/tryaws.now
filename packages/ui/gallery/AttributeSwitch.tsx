"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "../components/Button.tsx";
import { themeAttributes, type ThemeApp } from "../theme/public.ts";

type AttrSet = "customer" | "admin";

const APP_OF: Record<AttrSet, ThemeApp> = { customer: "web", admin: "admin" };

function apply(set: AttrSet): void {
  for (const [name, value] of Object.entries(themeAttributes(APP_OF[set]))) {
    document.body.setAttribute(name, value);
  }
}

/**
 * Sets the customer or the admin data attributes (16.4) on the body of this page, so both looks can
 * be seen in one app. It changes nothing on the server and restores the page's own attributes when
 * the gallery unmounts. This is the only script of the gallery besides the Tabs, Accordion and
 * overlay demos.
 */
export function AttributeSwitch({ app }: { app: ThemeApp }): ReactElement {
  const t = useTranslations("Gallery.attributes");
  const own: AttrSet = app === "admin" ? "admin" : "customer";
  const [current, setCurrent] = useState<AttrSet>(own);
  const original = useRef<AttrSet>(own);

  useEffect(() => {
    const restore = original.current;
    return () => apply(restore);
  }, []);

  const choose = (set: AttrSet): void => {
    setCurrent(set);
    apply(set);
  };

  return (
    <fieldset className="mb-4">
      <legend className="h6 mergecolor">{t("legend")}</legend>
      <div className="d-flex flex-wrap gap-2 mb-2">
        <Button
          size="sm"
          variant={current === "customer" ? "primary" : "default"}
          aria-pressed={current === "customer"}
          onClick={() => choose("customer")}
        >
          {t("customer")}
        </Button>
        <Button
          size="sm"
          variant={current === "admin" ? "primary" : "default"}
          aria-pressed={current === "admin"}
          onClick={() => choose("admin")}
        >
          {t("admin")}
        </Button>
      </div>
      <p className="small c-grey mb-0">{t("note")}</p>
    </fieldset>
  );
}
