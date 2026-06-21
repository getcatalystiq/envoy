import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// SDK-local test config. Its own `@sdk` alias (never the app's root `@/`) so SDK tests
// can never resolve into the app tree (KTD3).
export default defineConfig({
  resolve: {
    alias: {
      "@sdk": resolve(__dirname, "src"),
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
