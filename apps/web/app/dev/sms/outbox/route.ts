import { normalizeBdMobile } from "@tc/core";
import { readWebConfig } from "../../../../server/config.ts";

// Development and test only: the newest SMS the fake gateway "sent" to a number. Answers 404 unless
// the fake SMS switch is on, which config.ts refuses outside stage local or test (R3, R16).
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const notFound = () =>
  new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
  let on: boolean;
  try {
    on = readWebConfig(process.env).fake.sms;
  } catch {
    on = false;
  }
  if (!on) return notFound();
  const to = normalizeBdMobile(new URL(request.url).searchParams.get("to") ?? "");
  if (to === null)
    return Response.json({ error: "invalid" }, { status: 400, headers: JSON_HEADERS });
  const outbox = await import("../../../../server/fakes/outbox.ts");
  const found = [...outbox.getFakeSms().sent].reverse().find((message) => message.to === to);
  if (found === undefined)
    return Response.json({ error: "none" }, { status: 404, headers: JSON_HEADERS });
  return Response.json({ text: found.text }, { headers: JSON_HEADERS });
}
