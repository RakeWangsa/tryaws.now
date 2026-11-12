import { Button } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";

/** The pages of the Cloud Server family (WPU-G5): the list, the snapshots and the static IPs. */
export function ServersSubnav({
  locale,
  current,
}: {
  locale: Locale;
  current: "servers" | "snapshots" | "staticIps";
}) {
  const t = useTranslations("AccountNav");
  const links = [
    { id: "servers", href: "/servers" },
    { id: "snapshots", href: "/snapshots" },
    { id: "staticIps", href: "/static-ips" },
  ] as const;
  return (
    <nav aria-label={t("label")} className="d-flex flex-wrap gap-2 mb-4">
      {links.map((link) => (
        <Button
          key={link.id}
          size="sm"
          variant={link.id === current ? "primary" : "default"}
          href={localePath(locale, link.href)}
        >
          {t(link.id)}
        </Button>
      ))}
    </nav>
  );
}
