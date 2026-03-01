import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as sequences from "@/lib/queries/sequences";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const sequence = await sequences.getById(auth.tenantId, id);
  if (!sequence) {
    return jsonResponse({ detail: "Sequence not found" }, 404);
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const enrollments = await sequences.getEnrollments(auth.tenantId, {
    sequenceId: id,
    status,
    limit,
    offset,
  });

  return jsonResponse({
    items: enrollments,
    total: enrollments.length,
    limit,
    offset,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const sequence = await sequences.getById(auth.tenantId, id);
  if (!sequence) {
    return jsonResponse({ detail: "Sequence not found" }, 404);
  }

  if (sequence.status !== "active") {
    return jsonResponse(
      { detail: "Can only enroll in active sequences" },
      400
    );
  }

  const body = await request.json();
  const { target_id, first_step_delay_hours } = body;

  if (!target_id) {
    return jsonResponse({ error: "target_id is required" }, 400);
  }

  // Check for existing active enrollment
  const existing = await sequences.getActiveEnrollment(auth.tenantId, target_id, id);
  if (existing) {
    return jsonResponse(
      { detail: "Target already enrolled in this sequence" },
      409
    );
  }

  const enrollment = await sequences.enroll(
    auth.tenantId,
    target_id,
    id,
    first_step_delay_hours
  );

  return jsonResponse(enrollment, 201);
}
