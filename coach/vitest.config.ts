import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.engine.test.ts'],
        },
      },
      {
        test: {
          name: 'engine',
          environment: 'node',
          include: ['**/*.engine.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
