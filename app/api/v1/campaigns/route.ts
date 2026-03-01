import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as campaigns from "@/lib/queries/campaigns";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const items = await campaigns.getAll(auth.tenantId, { status, limit, offset });

  return jsonResponse({ items, total: items.length, limit, offset });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { name, target_criteria, skills, scheduled_at, settings } = body;

  if (!name) {
    return jsonResponse({ error: "name is required" }, 400);
  }

  const campaign = await campaigns.create(auth.tenantId, {
    name,
    targetCriteria: target_criteria,
    skills,
    scheduledAt: scheduled_at,
    settings,
  });

  return jsonResponse(campaign, 201);
}
