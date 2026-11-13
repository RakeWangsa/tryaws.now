import { adminGate } from "../../../server/gate.ts";
import { isSameOriginRequest } from "../../../server/same-origin.ts";
import { makeAuditExport } from "../../../server/audit-export.ts";
import { auditExportDeps } from "../../../server/runtime.ts";

// The CSV of the filtered audit view. No cache may keep it. The proxy does not run for /api, so the
// allowlist is checked here first.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!adminGate(request.headers.get("cloudfront-viewer-address"), process.env)) {
    return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  // The export writes an audit row: only the admin app itself may ask for it, not a link on another site.
  if (!isSameOriginRequest(request.headers, process.env)) {
    return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) query[key] ??= value;
  let answer;
  try {
    answer = await makeAuditExport(auditExportDeps())(query);
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(answer.status === 200 ? answer.body : null, {
    status: answer.status,
    headers: new Headers(answer.headers),
  });
}
