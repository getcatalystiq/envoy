import crypto from "node:crypto";
import { getEnv } from "@/lib/env";

export function verifyCronSecret(request: Request): Response | null {
  const env = getEnv();
  const cronSecret = env.CRON_SECRET;

  if (!cronSecret) {
    // Only allow unauthenticated cron in dev mode
    if (env.ENVIRONMENT === "dev") return null;
    return new Response("CRON_SECRET is required in production", { status: 401 });
  }

  const provided =
    request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(cronSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null; // Auth passed
}
