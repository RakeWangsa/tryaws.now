import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";

// Pure, so that a Client Component can import it without the server code of the review page.

/** The top-up page with the amount pre-filled and the review page as `next` (U12 is checked there). */
export function topUpHref(locale: Locale, taka: bigint, token: string): string {
  const next = `/orders/review?d=${token}`;
  return `${localePath(locale, "/wallet/topup")}?amount=${taka.toString()}&next=${encodeURIComponent(next)}`;
}
