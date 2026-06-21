import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// SDK-local test config. Its own `@sdk` alias (never the app's root `@/`) so SDK tests
// can never resolve into the app tree (KTD3).
export default defineConfig({
  resolve: {
    // Single React copy across the SDK's own `react` and the test renderer (`@testing-library/react`
    // + `react-dom`, hoisted to the repo root). The SDK nests its own `react`, while `react-dom`
    // lives only at the repo root — so the U17 hook tests would otherwise load two React instances
    // (the hooks dispatcher is per-copy) and `useState` throws "Cannot read properties of null".
    // Pin both to the root copy that the renderer uses. `dedupe` reinforces it for transitive deps.
    // Node-env tests don't import React, so this is inert for them.
    dedupe: ["react", "react-dom"],
    alias: {
      react: resolve(__dirname, "../../node_modules/react"),
      "react-dom": resolve(__dirname, "../../node_modules/react-dom"),
      "@sdk": resolve(__dirname, "src"),
      // `import "server-only"` throws when evaluated outside a real RSC bundler (its index.js
      // is a hard guard). Under Vitest there is no Next.js boundary, so alias it to the no-op
      // `empty.js` the package ships for exactly this — preserving the server-only guard in the
      // real build (tsup marks `server-only` external) while letting node-env tests import the
      // server modules.
      "server-only": resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // Per-file jsdom via `// @vitest-environment jsdom` for hook tests (U17).
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["node_modules", "dist"],
  },
});
