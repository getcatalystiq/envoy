import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import {
  graduateTarget,
  GraduationError,
  TargetNotFoundError,
  UnauthorizedError,
} from "@/lib/graduation";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const body = await request.json();
  const { destination_target_type_id } = body;

  if (!destination_target_type_id) {
    return jsonResponse({ error: "destination_target_type_id is required" }, 400);
  }

  try {
    const event = await graduateTarget({
      orgId: auth.tenantId,
      targetId: id,
      destinationTypeId: destination_target_type_id,
      userId: auth.userId,
    });
    return jsonResponse(event);
  } catch (e) {
    if (e instanceof TargetNotFoundError) {
      return jsonResponse({ error: "Target not found" }, 404);
    }
    if (e instanceof UnauthorizedError) {
      return jsonResponse({ error: "Target not found" }, 404);
    }
    if (e instanceof GraduationError) {
      return jsonResponse({ error: e.message }, 400);
    }
    throw e;
  }
}
