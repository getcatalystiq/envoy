import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as outbox from "@/lib/queries/outbox";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const [items, total] = await Promise.all([
    outbox.listPending(auth.tenantId, limit, offset),
    outbox.count(auth.tenantId, "pending"),
  ]);

  return jsonResponse({ items, total, limit, offset });
}
