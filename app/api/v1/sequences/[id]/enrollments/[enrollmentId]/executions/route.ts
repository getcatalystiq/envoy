import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as sequences from "@/lib/queries/sequences";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; enrollmentId: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { enrollmentId } = await params;
  const enrollment = await sequences.getEnrollmentById(auth.tenantId, enrollmentId);
  if (!enrollment) {
    return jsonResponse({ detail: "Enrollment not found" }, 404);
  }

  const executions = await sequences.getStepExecutions(auth.tenantId, enrollmentId);
  return jsonResponse(executions);
}
