import { defineConfig } from "tsup";

// Two entry points (KTD4): a server-only bundle (".") and a client bundle ("./client").
// esbuild strips top-of-file directives, so the client build re-injects "use client"
// via `banner`; `server-only` is marked external so the guard module never lands in a
// client bundle.
//
// Two separate config objects are required because `banner` is per-config (the "use client"
// directive must NOT land on the server bundle). They must NOT each `clean` — concurrent
// configs racing on `clean: true` wipe each other's just-emitted .d.ts. The build script does
// a single `rm -rf dist` before tsup instead; both configs run with clean disabled.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "es2022",
    external: ["server-only", "react", "next"],
  },
  {
    entry: { "client/index": "src/client/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "es2022",
    external: ["server-only", "react", "next"],
    banner: { js: '"use client";' },
  },
]);
