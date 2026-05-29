import type { NextConfig } from "next";

// Security headers (nosniff, Referrer-Policy, HSTS, frame options, DNS-prefetch)
// are set in proxy.ts (the runtime middleware) so they can be conditioned on the
// path (/embed framing) and environment (HSTS only in prod).
const nextConfig: NextConfig = {};

export default nextConfig;
