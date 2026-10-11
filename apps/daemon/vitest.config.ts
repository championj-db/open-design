import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // These suites mutate process-wide env/PATH and bind real local servers.
    // Keep files serial so fake agent binaries stay scoped to their tests.
    fileParallelism: false,
    include: ['tests/**/*.test.{ts,tsx,js,mjs,cjs}'],
    globalSetup: ['tests/global-setup-postgres.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    // Hooks that boot the daemon run its migrations and bundled-plugin
    // registration against Postgres, which is several seconds slower than the
    // old in-process SQLite file.
    hookTimeout: 30_000,
  },
});
