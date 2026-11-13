import { Button } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";

/** The pages of the Cloud Server family (WPU-G5): the list, the snapshots, the static IPs and the disks (WPU-Y4). */
export function ServersSubnav({
  locale,
  current,
}: {
  locale: Locale;
  current: "servers" | "snapshots" | "staticIps" | "disks";
}) {
  const t = useTranslations("AccountNav");
  const links = [
    { id: "servers", href: "/servers" },
    { id: "snapshots", href: "/snapshots" },
    { id: "staticIps", href: "/static-ips" },
    // WPU-Y4: every disk of the customer, attached or not.
    { id: "disks", href: "/servers/disks" },
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
