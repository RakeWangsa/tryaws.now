import { handleHeadRequest, handleReturnRequest } from "../handle.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleReturnRequest(request, "cancel");
}

export function HEAD(): Response {
  return handleHeadRequest();
}
