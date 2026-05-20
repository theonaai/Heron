import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': root.replace(/\/$/, ''),
    },
  },
  esbuild: {
    // The `.tsx` snapshot tests for the React dashboard components need
    // the automatic JSX transform (React 19) so `import React from 'react'`
    // isn't required in every test file. `.ts` files are unaffected.
    jsx: 'automatic',
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: true,
    // §7.4 / AAP-59 — point HERON_SESSIONS_DIR, HERON_CREDENTIALS_PATH,
    // HERON_DISCOVERY_HOME at per-process mktemp paths so tests never
    // touch the user's real ~/.heron/ dashboard data. Per-test
    // overrides still win.
    setupFiles: ['./tests/setup.ts'],
  },
});
