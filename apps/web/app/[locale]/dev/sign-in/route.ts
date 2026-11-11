import { sessionSetCookies } from "@tc/auth";
import { isLocale, localePath } from "@tc/ui/runtime";
import { notFound } from "next/navigation";
import { devSurfaceEnabled } from "../../../../server/dev-surface.ts";

// Development and test only (WP3-T4 Task 8): signs the browser in as a seeded customer by setting
// the session cookies, so that Playwright can open the wallet. Under [locale] and not at the top
// level, because the proxy puts every path but /pay and /api under a locale. A 404 unless the
// configuration says fakes. The token `dev.<sub>` is accepted only by the dev verifier, which
// runtime.ts loads only in that case.

export const dynamic = "force-dynamic";

const SUB = /^[A-Za-z0-9_-]{1,64}$/;
const ONE_HOUR_MS = 3_600_000;

export async function GET(
  request: Request,
  context: { params: Promise<{ locale: string }> },
): Promise<Response> {
  if (!devSurfaceEnabled()) notFound();
  const { locale } = await context.params;
  const sub = new URL(request.url).searchParams.get("sub");
  if (!isLocale(locale) || sub === null || !SUB.test(sub)) notFound();

  const clock = { now: () => new Date() };
  const cookies = sessionSetCookies(
    { accessToken: `dev.${sub}`, accessExpiresAt: new Date(clock.now().getTime() + ONE_HOUR_MS) },
    clock,
  );
  const headers = new Headers({
    Location: localePath(locale, "/wallet"),
    "Cache-Control": "no-store",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}
