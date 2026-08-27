import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    maxWorkers: 1,
    testTimeout: 10_000,
  },
});
