#!/usr/bin/env node
// Copy @bytecodealliance/preview2-shim browser builds into public/preview2-shim/
// so Vite bundles them into the production GH Pages output. The transpiled
// wasm components reference these shims by absolute URL (location.origin +
// '/preview2-shim/cli.js'), so they must be at a stable path.

import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'node_modules/@bytecodealliance/preview2-shim/lib/browser');
const dst = join(root, 'public/preview2-shim');

await mkdir(dst, { recursive: true });
const files = await readdir(src);
let n = 0;
for (const f of files) {
  if (f.endsWith('.js') || f.endsWith('.js.map')) {
    await copyFile(join(src, f), join(dst, f));
    n++;
  }
}
console.log(`copied ${n} shim files: ${src} → ${dst}`);
