import { parseCspReports, violationLogLine } from "@tc/ui/runtime";

// Anonymous by design (R9, open point: no rate limit yet): the body is capped, parsed defensively
// and never echoed. Only the sanitized fields of a report are logged (R14).
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16384;

// A parse error counts as no report.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  const contentType = request.headers.get("content-type");
  for (const violation of parseCspReports(contentType, parseJson(text))) {
    process.stdout.write(`${violationLogLine("admin", violation)}\n`);
  }
  return new Response(null, { status: 204 });
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
