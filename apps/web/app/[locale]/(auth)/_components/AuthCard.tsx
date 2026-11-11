import type { ReactNode } from "react";
import type { Locale } from "@tc/ui/runtime";
import { AuthTabs } from "./AuthTabs.tsx";

/**
 * The inside of the card of login.html (the frame is AuthShell): the random line, the h2, the intro
 * and, on /login and /signup, the two tabs.
 */
export function AuthCard({
  title,
  intro,
  tabs,
  children,
}: {
  title: string;
  intro?: string;
  tabs?: { active: "login" | "signup"; locale: Locale; next?: unknown };
  children: ReactNode;
}) {
  return (
    <>
      <div className="randomline">
        <div className="bigline" />
        <div className="smallline" />
      </div>
      <h2 className="mergecolor">
        <b>{title}</b>
      </h2>
      {intro !== undefined ? <p className="mb-5 mergecolor">{intro}</p> : null}
      {tabs !== undefined ? <AuthTabs {...tabs} /> : null}
      {children}
    </>
  );
}

/** The body of one tab of login.html: `div.table.tabs-item.active > div.cd-filter-block > h4 + div.cd-filter-content`. */
export function AuthBody({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="row">
      <div className="col-sm-12">
        <div className="table tabs-item active">
          <div className="cd-filter-block mb-0">
            <h4 className="m-0 mergecolor">{heading}</h4>
            <div className="cd-filter-content">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
