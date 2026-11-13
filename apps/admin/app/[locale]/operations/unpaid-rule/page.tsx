import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { UnpaidRuleView, unpaidRuleResultOf } from "../../../_components/UnpaidRuleView.tsx";
import { loadPageAdmin } from "../../../../server/page-admin.ts";
import { loadUnpaidRule } from "../../../../server/unpaid-rule-data.ts";
import { UNPAID_RULE_READ_ROLES } from "../../../../server/unpaid-rule-flow.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PATH = "/operations/unpaid-rule";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminUnpaidRule" });
  return { title: t("title") };
}

// WPU-Z4 /operations/unpaid-rule: the switch of the daily unpaid-usage job for each market. A page of the
// operations area that every role reads (its own role list, wider than the queue's); superadmin turns it on,
// ops and superadmin turn it off. The role guard runs first (R9 steps 1 and 2); a refusal of the guard or of
// the repository (disabled admin, other role) shows the neutral page and reads nothing more.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "operations", UNPAID_RULE_READ_ROLES);
  if (loaded.kind === "denied") return <NoAccess locale={locale} path={PATH} />;
  const screen = await loadUnpaidRule(loaded.admin);
  if (screen.kind === "denied") return <NoAccess locale={locale} path={PATH} />;
  const raw = await searchParams;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="operations" path={PATH}>
      <UnpaidRuleView
        locale={locale}
        admin={loaded.admin}
        screen={screen}
        result={unpaidRuleResultOf(raw["result"])}
      />
    </AdminFrame>
  );
}
