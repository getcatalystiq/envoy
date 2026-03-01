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
  const url = new URL(request.url);
  const reason = url.searchParams.get("reason") ?? "manual_exit";

  const enrollment = await sequences.completeEnrollment(
    auth.tenantId,
    enrollmentId,
    "exited",
    reason
  );
  if (!enrollment) {
    return jsonResponse(
      { detail: "Enrollment not found or already completed" },
      400
    );
  }

  return jsonResponse(enrollment);
}
