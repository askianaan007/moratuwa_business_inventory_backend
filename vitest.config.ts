import { defineConfig } from "vitest/config";

/**
 * Integration tests need a throwaway PostgreSQL database with migrations and
 * the main seed applied. They never run against DATABASE_URL from .env:
 *   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/labtest npm test
 * Without TEST_DATABASE_URL only the pure unit tests run.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://unused@localhost:1/unused",
      JWT_SECRET: "test-only-secret-that-is-long-enough-123",
      LOG_LEVEL: "silent",
    },
  },
});
