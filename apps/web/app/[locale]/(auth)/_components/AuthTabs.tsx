import { useTranslations } from "next-intl";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { safeNext } from "../../../../server/next-path.ts";

/**
 * The two tabs of login.html as links (open point 23): the mockup switches them with a script, the
 * spec makes them the routes /login and /signup. Same classes: `div.tabs-header > ul.btn-group >
 * li.btn.btn-secondary(.active)`, with the link inside the item. `next` is kept only when it passes
 * the allow-list (U12).
 */
export function AuthTabs({
  active,
  locale,
  next,
}: {
  active: "login" | "signup";
  locale: Locale;
  next?: unknown;
}) {
  const t = useTranslations("Auth.tabs");
  const safe = safeNext(next);
  const suffix = safe === null ? "" : `?next=${encodeURIComponent(safe)}`;
  const items = [
    { id: "login", href: `${localePath(locale, "/login")}${suffix}` },
    { id: "signup", href: `${localePath(locale, "/signup")}${suffix}` },
  ] as const;
  return (
    <nav aria-label={t("label")}>
      <div className="tabs-header btn-select-customer">
        <ul className="btn-group d-block">
          {items.map((item) => (
            <li
              key={item.id}
              className={`btn btn-secondary tc-auth-tab${item.id === active ? " active tc-auth-tab-current" : ""} mb-2`}
            >
              <a href={item.href} aria-current={item.id === active ? "page" : undefined}>
                {t(item.id)}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
