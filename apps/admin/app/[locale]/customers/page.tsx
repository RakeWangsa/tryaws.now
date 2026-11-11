import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { CustomersView } from "../../_components/CustomersView.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { loadCustomerList, loadKycQueue, queryOf } from "../../../server/customers-data.ts";
import { loadPageAdmin } from "../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminCustomers" });
  return { title: t("title") };
}

// 16.12 /customers: search, and the KYC queue as the filter "waiting". support, ops and superadmin read.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "customers");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/customers" />;
  const query = queryOf(await searchParams);
  const asQueue = query.kyc === "pending" && query.q === "" && query.after === null;
  const [list, queue] = await Promise.all([
    asQueue
      ? Promise.resolve({ kind: "unavailable" as const })
      : loadCustomerList(loaded.admin, query),
    asQueue ? loadKycQueue(loaded.admin) : Promise.resolve(null),
  ]);
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="customers">
      <CustomersView locale={locale} query={query} list={list} queue={queue} />
    </AdminFrame>
  );
}
