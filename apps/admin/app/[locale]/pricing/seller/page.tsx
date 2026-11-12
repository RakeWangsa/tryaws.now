import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { InvoiceSellerView } from "../../../_components/InvoiceSellerView.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { loadInvoiceSeller } from "../../../../server/invoice-seller-data.ts";
import { loadPageAdmin } from "../../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminInvoiceSeller" });
  return { title: t("title") };
}

// 16.12 /pricing/seller, the seller of the tax invoices (Mushak 6.3): finance and superadmin, as /pricing. The
// role guard runs first (R9 steps 1 and 2); a refusal shows the neutral page and reads nothing.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "pricing");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/pricing/seller" />;
  const raw = await searchParams;
  const screen = await loadInvoiceSeller(loaded.admin, raw);
  const result = typeof raw["result"] === "string" ? raw["result"] : null;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="pricing">
      <InvoiceSellerView locale={locale} screen={screen} result={result} />
    </AdminFrame>
  );
}
