import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  { test: { name: 'shared', root: './packages/shared', include: ['test/**/*.test.ts'] } },
  {
    test: {
      name: 'engine',
      root: './packages/engine',
      include: ['test/**/*.test.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
  {
    test: {
      name: 'backend',
      root: './apps/backend',
      include: ['test/**/*.test.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      fileParallelism: false,
    },
  },
]);
