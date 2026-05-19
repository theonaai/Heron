/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Hosts a single-user CLI tool — no remote images, no telemetry, no
  // build-time external fetches. Keeps the bundle predictable and the
  // serverless surface minimal.
  images: { unoptimized: true },
  reactStrictMode: true,
  // The CLI re-uses some `src/` modules that import Node-only APIs (fs,
  // crypto, child_process). Mark them as external so Next.js does not try
  // to bundle them into the edge runtime when route handlers import them.
  experimental: {
    serverComponentsExternalPackages: ['@modelcontextprotocol/sdk'],
  },
};

export default nextConfig;
