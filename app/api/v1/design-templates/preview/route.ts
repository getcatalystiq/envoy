import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  // Email-builder content preview is handled client-side
  return jsonResponse({
    html: "",
    text: "",
    errors: ["Email builder content preview is handled client-side"],
  });
}
