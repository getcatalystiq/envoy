import { jsonResponse } from "@/lib/utils";
import * as twin from "@/lib/twin";
import { twinListRunsQuerySchema } from "@/lib/schemas";
import { withTwinAgent } from "../_helpers";

const VALID_FILTER_STATUSES = new Set([
  "queued",
  "running",
  "finished",
  "failed",
  "cancelled",
  "canceled",
]);

function parsePositiveInt(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

export async function GET(request: Request) {
  return withTwinAgent(request, async ({ agentId, apiKey }) => {
    const url = new URL(request.url);

    // Modern params
    const pageRaw = url.searchParams.get("page");
    const pageSizeRaw = url.searchParams.get("page_size");
    // Legacy aliases
    const limitRaw = url.searchParams.get("limit");
    const offsetRaw = url.searchParams.get("offset");
    const statusRaw =
      url.searchParams.get("filter_status") ?? url.searchParams.get("status");

    const pageSize =
      parsePositiveInt(pageSizeRaw) ?? parsePositiveInt(limitRaw) ?? 50;
    if (pageSize > 200) {
      return jsonResponse({ error: "page_size must be <= 200" }, 400);
    }

    let page = parsePositiveInt(pageRaw);
    if (page === null) {
      const offset = offsetRaw === null ? null : Number.parseInt(offsetRaw, 10);
      if (offset !== null && Number.isFinite(offset) && offset >= 0) {
        page = Math.floor(offset / pageSize) + 1;
      } else {
        page = 1;
      }
    }

    let filterStatus: string | undefined;
    if (statusRaw !== null) {
      if (!VALID_FILTER_STATUSES.has(statusRaw)) {
        return jsonResponse({ error: "invalid filter_status" }, 400);
      }
      filterStatus = statusRaw;
    }

    const parsed = twinListRunsQuerySchema.safeParse({
      page,
      page_size: pageSize,
      filter_status: filterStatus,
    });
    if (!parsed.success) {
      return jsonResponse(
        { error: "Invalid query parameters", detail: parsed.error.issues },
        400,
      );
    }

    const result = await twin.listRuns(agentId, {
      page,
      pageSize,
      filterStatus,
      apiKey,
    });
    return jsonResponse(result);
  });
}
