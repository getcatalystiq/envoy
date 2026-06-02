import { vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Test env defaults — most lib/env consumers can rely on these.
process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-32-characters-long";
process.env.NEXT_PUBLIC_URL = "http://localhost:3000";
process.env.SES_ACCESS_KEY_ID = "test-key";
process.env.SES_SECRET_ACCESS_KEY = "test-secret";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID = "env_test";
process.env.ENVIRONMENT = "dev";
process.env.CRON_SECRET = "test-cron-secret";

// Reset all timers and mocks between tests to keep them isolated.
beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});
