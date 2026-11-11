import { adminGate } from "../../../../../server/gate.ts";
import { kycDocumentDeps } from "../../../../../server/runtime.ts";
import { makeKycDocumentHandler } from "../../../../../server/kyc-documents.ts";

// One image of a KYC document: the answer is a redirect to a presigned URL that lives for seconds, and
// no cache may keep it. The proxy does not run for /api, so the allowlist is checked here first.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ submissionId: string; index: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  if (!adminGate(request.headers.get("cloudfront-viewer-address"), process.env)) {
    return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const { submissionId, index } = await params;
  let answer;
  try {
    answer = await makeKycDocumentHandler(kycDocumentDeps())({ submissionId, index });
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const headers = new Headers(answer.headers);
  if (answer.status === 302) headers.set("Location", answer.location);
  return new Response(null, { status: answer.status, headers });
}
