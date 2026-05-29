import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Legacy path redirects
  if (pathname === "/setup") {
    return NextResponse.redirect(new URL("/settings", request.url));
  }
  if (pathname === "/email-settings") {
    return NextResponse.redirect(
      new URL("/settings?tab=email", request.url)
    );
  }

  const response = NextResponse.next();

  // Security headers
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-DNS-Prefetch-Control", "off");

  // HSTS only in production (the header is ignored over http anyway, but we
  // avoid asserting includeSubDomains/preload from preview/staging domains).
  if (process.env.ENVIRONMENT === "prod") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  // Deny framing everywhere EXCEPT pages designed to be embedded: the OAuth
  // authorize page (ChatGPT/Claude.ai OAuth popup) and the /embed views.
  if (
    !pathname.startsWith("/api/oauth/authorize") &&
    !pathname.startsWith("/embed")
  ) {
    response.headers.set("X-Frame-Options", "DENY");
  }

  // CORS only for routes that require cross-origin access
  if (
    pathname.startsWith("/mcp") ||
    pathname.startsWith("/.well-known/") ||
    pathname.startsWith("/api/oauth/") ||
    pathname.startsWith("/api/webhooks/")
  ) {
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id"
    );
    response.headers.set("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (request.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: response.headers });
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    "/mcp",
    "/.well-known/:path*",
    "/setup",
    "/email-settings",
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
