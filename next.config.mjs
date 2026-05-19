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
  serverExternalPackages: ['@modelcontextprotocol/sdk'],
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
