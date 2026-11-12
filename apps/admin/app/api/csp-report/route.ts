import { parseCspReports, violationLogLine } from "@tc/ui/runtime";
import { CSP_REPORT_MAX_BYTES, cspReportBody } from "../../../server/schemas.ts";
import { adminGate } from "../../../server/gate.ts";

// Anonymous by design (R9, open point: no rate limit yet): the body is capped, parsed defensively
// and never echoed. Only the sanitized fields of a report are logged (R14).
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = CSP_REPORT_MAX_BYTES;

// A parse error counts as no report.
function parseJson(text: string): unknown {
  try {
    // Validate (R9): a report is one object or a list; anything else counts as no report.
    const parsed = cspReportBody.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  // The proxy does not run for /api (its matcher is the next-intl one), so the allowlist is checked here.
  if (!adminGate(request.headers.get("cloudfront-viewer-address"), process.env)) {
    return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
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
