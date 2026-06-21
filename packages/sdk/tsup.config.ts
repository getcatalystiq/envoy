import { defineConfig } from "tsup";

// Two entry points (KTD4): a server-only bundle (".") and a client bundle ("./client").
// esbuild strips top-of-file directives, so the client build re-injects "use client"
// via `banner`; `server-only` is marked external so the guard module never lands in a
// client bundle.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
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
