import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
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

  // Allow OAuth authorize page to be framed (for ChatGPT/Claude.ai OAuth popup)
  if (!pathname.startsWith("/api/oauth/authorize")) {
    response.headers.set("X-Frame-Options", "DENY");
  }

  // CORS for API routes, MCP, and .well-known
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/mcp") ||
    pathname.startsWith("/.well-known/")
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
