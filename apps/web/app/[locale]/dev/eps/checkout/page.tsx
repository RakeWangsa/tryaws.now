import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { devEps, devSurfaceEnabled, isDevData } from "../../../../../server/dev-surface.ts";
import { getRuntime } from "../../../../../server/runtime.ts";
import { settleFakeEps } from "./actions.ts";

// Development and test only (WP3-T4 Task 8): the page that stands in for the EPS hosted page. Plain
// English text, not part of the product and not a message of the app; a 404 unless fakes are on.

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function FakeEpsCheckout({ searchParams }: Props) {
  if (!devSurfaceEnabled()) notFound();
  // Builds the fake runtime if this process has not yet: the bridge exists after this call.
  await getRuntime();
  const { data } = await searchParams;
  if (!isDevData(data) || devEps()?.byData.has(data) !== true) notFound();

  return (
    <main className="container py-5">
      <h1 className="h3 mergecolor">Fake EPS</h1>
      <p className="seccolor">
        Development only. Choose what the payment gateway should answer; the browser then returns to
        the app as it would from EPS.
      </p>
      <form action={settleFakeEps}>
        <input type="hidden" name="data" value={data} />
        <button
          type="submit"
          name="outcome"
          value="pay"
          className="btn btn-default-yellow-fill me-2"
        >
          Pay
        </button>
        <button type="submit" name="outcome" value="fail" className="btn btn-default-fill me-2">
          Fail
        </button>
        <button type="submit" name="outcome" value="cancel" className="btn btn-default-fill">
          Cancel
        </button>
      </form>
    </main>
  );
}
