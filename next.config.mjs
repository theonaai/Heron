import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Pin the workspace root to this directory. Without this, Next.js
  // auto-detects the root by walking up looking for a lockfile, and if
  // a stray ~/package-lock.json exists in the user's home directory
  // (a common accident), Next.js picks $HOME as the root and the
  // standalone output silently lands in the wrong place — leaving
  // .next/standalone empty. Pinning here makes the build deterministic.
  outputFileTracingRoot: __dirname,
  // Hosts a single-user CLI tool — no remote images, no telemetry, no
  // build-time external fetches. Keeps the bundle predictable and the
  // serverless surface minimal.
  images: { unoptimized: true },
  reactStrictMode: true,
  // The CLI re-uses some `src/` modules that import Node-only APIs (fs,
  // crypto, child_process). Mark them as external so Next.js does not try
  // to bundle them into the edge runtime when route handlers import them.
  //
  // The @secretlint/* entries (AAP-57) fix a standalone-build regression:
  // `src/discovery/secretlint-scrub.ts` only statically imports
  // `@secretlint/node`, which then dynamically loads its rule modules
  // (preset-recommend + secretlint-rule-pattern) by name via
  // `require.resolve(...)` at runtime. Next.js's static tracer can't
  // follow those dynamic requires, so the rule packages were not
  // copied into `.next/standalone/node_modules/@secretlint/`. Listing
  // them as serverExternalPackages keeps them out of the webpack
  // bundle (correct — they must be required from node_modules at
  // runtime) AND triggers Next to include them in the standalone
  // node_modules tree. Without this fix, the discovery
  // `/api/discovery/scan` route throws
  // `Cannot find module 'file:///.../module/index.js'` and returns 500
  // to the dashboard "Run verification" button.
  serverExternalPackages: [
    '@modelcontextprotocol/sdk',
    '@secretlint/node',
    '@secretlint/secretlint-rule-preset-recommend',
    '@secretlint/secretlint-rule-pattern',
  ],
  // Safety net: even with serverExternalPackages declared, dynamic
  // resolve patterns can still escape Next's tracer. Glob-include the
  // entire @secretlint scope for the discovery scan route so every
  // sub-package on disk is copied verbatim into standalone.
  outputFileTracingIncludes: {
    '/api/discovery/scan': ['./node_modules/@secretlint/**/*'],
  },
  // The src/ tree compiles to ESM under the CLI tsconfig (NodeNext, which
  // requires explicit .js suffixes on relative imports). Next.js's webpack
  // resolver doesn't know about that convention, so we wire an alias so
  // `from '../foo.js'` resolves to `../foo.ts` when imported into a route
  // handler. AAP-52 needed this once `app/mcp/route.ts` started pulling
  // mcp-server.ts in via Next.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
