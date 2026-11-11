import { DEFAULT_LOCALE, isLocale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { NotFoundContent } from "./NotFoundContent.tsx";

/**
 * The same answer for an unknown payment and for another customer's payment (R8): no hint which of
 * the two it is. It carries no shell and no data.
 */
export default async function PaymentNotFound() {
  const requested = await getLocale();
  return <NotFoundContent locale={isLocale(requested) ? requested : DEFAULT_LOCALE} />;
}
