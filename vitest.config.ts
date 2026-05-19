import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': root.replace(/\/$/, ''),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
  },
});
