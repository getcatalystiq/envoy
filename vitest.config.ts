import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // Per-file environments are set via `// @vitest-environment jsdom`
    // directives at the top of component test files (test/components/**).
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["node_modules", ".next", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      exclude: [
        "node_modules/**",
        ".next/**",
        "test/**",
        "scripts/**",
        "migrations/**",
        "**/*.d.ts",
        "vitest.config.ts",
        "next.config.*",
        "postcss.config.*",
        "tailwind.config.*",
        "eslint.config.*",
      ],
    },
  },
});
