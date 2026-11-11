import { normalizeEmail } from "@tc/core";
import { readWebConfig } from "../../../../server/config.ts";

// Development and test only: the newest email code the fake identity provider "sent" to an address.
// Answers 404 unless the fake identity switch is on, which config.ts refuses outside stage local or
// test (R3, R16). Never in a production bundle (scripts/lib/app-checks.mjs).
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const notFound = () =>
  new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
  let on: boolean;
  try {
    on = readWebConfig(process.env).fake.idp;
  } catch {
    on = false;
  }
  if (!on) return notFound();
  const email = normalizeEmail(new URL(request.url).searchParams.get("email"));
  if (email === null)
    return Response.json({ error: "invalid" }, { status: 400, headers: JSON_HEADERS });
  const outbox = await import("../../../../server/fakes/outbox.ts");
  const entry = outbox.getFakeState().emailCodes.get(email);
  if (entry === undefined)
    return Response.json({ error: "none" }, { status: 404, headers: JSON_HEADERS });
  return Response.json({ kind: entry.kind, code: entry.code }, { headers: JSON_HEADERS });
}
