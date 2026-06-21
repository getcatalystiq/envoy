// The host's own enroll endpoint — the EVENT-DRIVEN entry into Envoy.
//
// This is intentionally a host route (NOT the mounted /api/envoy surface): enrollment is a
// product event the host decides ("a user signed up"), so the host authenticates it however
// it likes and calls `enroll(...)` directly. The example's "Enroll" button POSTs here.

import { enroll } from "@envoy/sdk";

import { envoy, WELCOME_SEQUENCE_KEY } from "../../../envoy";

export async function POST(request: Request): Promise<Response> {
  // The host owns auth on its own routes. The example trusts the same admin token as /api/envoy.
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${process.env.EXAMPLE_ADMIN_TOKEN ?? ""}` || !process.env.EXAMPLE_ADMIN_TOKEN) {
    return new Response(null, { status: 401 });
  }

  let body: { email?: unknown; firstName?: unknown; company?: unknown; plan?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.email !== "string" || body.email.length === 0) {
    return Response.json({ error: "email_required" }, { status: 400 });
  }

  // Enroll into the welcome drip. Only allow-listed `data` fields reach the AI payload (R44);
  // the rest is stored on the mirror row. A suppressed contact records the enrollment but is not
  // synced/sent — the result's `suppressed` flag reports it. Resend failures are fail-soft.
  const result = await enroll(
    envoy,
    {
      email: body.email,
      data: {
        firstName: typeof body.firstName === "string" ? body.firstName : undefined,
        company: typeof body.company === "string" ? body.company : undefined,
        plan: typeof body.plan === "string" ? body.plan : undefined,
      },
    },
    WELCOME_SEQUENCE_KEY,
    // Reflect a digest Topic so the recipient can opt out of the lane from Resend's preference page.
    { topic: { stream: "digest", subject: "welcome" } },
  );

  return Response.json(result);
}
