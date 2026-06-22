#!/usr/bin/env node
// Copy browser shim builds into public/ so Vite bundles them into the
// production GH Pages output. Two sources:
//   1. @bytecodealliance/preview2-shim → public/preview2-shim/
//   2. @actcore/host's wasi:http p3 shim → public/host/shims/
// Transpiled wasm components reference both by absolute URL.

import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function copyJs(src, dst, label) {
  await mkdir(dst, { recursive: true });
  let n = 0;
  for (const f of await readdir(src)) {
    if (f.endsWith('.js') || f.endsWith('.js.map')) {
      await copyFile(join(src, f), join(dst, f));
      n++;
    }
  }
  console.log(`copied ${n} ${label} files: ${src} → ${dst}`);
}

await copyJs(
  // preview2-shim 0.19 moved its browser build lib/browser → dist/browser.
  join(root, 'node_modules/@bytecodealliance/preview2-shim/dist/browser'),
  join(root, 'public/preview2-shim'),
  'preview2-shim',
);

await copyJs(
  join(root, 'node_modules/@actcore/host/dist/shims'),
  join(root, 'public/host/shims'),
  'host-shim',
);
