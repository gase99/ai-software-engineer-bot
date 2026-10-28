import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The suite is fully offline: HTTP is replaced by FetchMock and the
    // database runs on in-memory SQLite.
    testTimeout: 20_000,
    isolate: false,
    reporters: ['default'],
  },
});
