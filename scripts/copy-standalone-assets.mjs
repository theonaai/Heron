#!/usr/bin/env node
/**
 * Copy static and public assets into .next/standalone/ after `next build`.
 *
 * Next.js standalone mode (output: 'standalone') produces a minimal
 * .next/standalone/server.js but does NOT bundle the static chunks
 * (.next/static/*) or the public/ directory by design — they're meant
 * to be served by a separate CDN in production. For our single-process
 * `heron` command we serve everything from one server, so we need to
 * stitch the assets into the standalone tree ourselves.
 *
 * Without this, `heron` starts but the dashboard loads with no CSS or JS.
 *
 * See: https://nextjs.org/docs/app/api-reference/config/next-config-js/output#automatically-copying-traced-files
 */

import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const STANDALONE_DIR = resolve(root, '.next', 'standalone');
const STATIC_SRC = resolve(root, '.next', 'static');
const STATIC_DEST = resolve(STANDALONE_DIR, '.next', 'static');
const PUBLIC_SRC = resolve(root, 'public');
const PUBLIC_DEST = resolve(STANDALONE_DIR, 'public');

if (!existsSync(STANDALONE_DIR)) {
  console.error(
    'Skipping standalone asset copy: .next/standalone does not exist. ' +
    'Did `next build` finish successfully?',
  );
  process.exit(0);
}

async function copyTree(src, dest, label) {
  if (!existsSync(src)) {
    console.log(`  skip ${label}: source missing (${src})`);
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
  console.log(`  copied ${label} → ${dest.replace(root + '/', '')}`);
}

await copyTree(STATIC_SRC, STATIC_DEST, '.next/static');
await copyTree(PUBLIC_SRC, PUBLIC_DEST, 'public');

console.log('Standalone assets ready.');
