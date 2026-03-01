import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as graduation from "@/lib/queries/graduation";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const events = await graduation.getEvents(auth.tenantId, limit, offset);
  return jsonResponse(events);
}
