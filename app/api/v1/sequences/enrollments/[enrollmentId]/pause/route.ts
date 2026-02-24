import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as sequences from "@/lib/queries/sequences";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ enrollmentId: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { enrollmentId } = await params;
  const enrollment = await sequences.pauseEnrollment(auth.tenantId, enrollmentId);
  if (!enrollment) {
    return jsonResponse(
      { detail: "Enrollment not found or not active" },
      400
    );
  }

  return jsonResponse(enrollment);
}
