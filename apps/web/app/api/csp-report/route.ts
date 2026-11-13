import { parseCspReports, violationLogLine } from "@tc/ui/runtime";

// Anonymous by design (R9, open point: no rate limit yet): the body is capped before it is read (the
// content-length is judged first and the stream is cut at the cap), parsed defensively and never
// echoed. Only the sanitized fields of a report are logged (R14).
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

// The text of the body, or null when it is larger than the cap. A declared length above the cap (or
// one that is not a plain number) is refused without touching the body; a body that is longer than it
// said, or that declared nothing, is read chunk by chunk and cancelled at the first byte over the cap.
async function readCapped(request: Request): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]{1,15}$/.test(declared) || Number(declared) > MAX_BODY_BYTES) return null;
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // A body that cannot be read counts as no report.
    return "";
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function POST(request: Request): Promise<Response> {
  const text = await readCapped(request);
  if (text === null) return new Response(null, { status: 413 });
  const contentType = request.headers.get("content-type");
  for (const violation of parseCspReports(contentType, parseJson(text))) {
    process.stdout.write(`${violationLogLine("web", violation)}\n`);
  }
  return new Response(null, { status: 204 });
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
