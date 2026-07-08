import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// @actcore/web-runtime imports jco's in-browser transpiler from the vendored,
// componentized bindgen at this subpath. jco-transpile does not list `./vendor/*`
// in its package `exports`, so Vite/Rollup's exports-respecting resolver can't
// reach it — alias it to the concrete file. (jco's documented browser entry,
// @bytecodealliance/jco/component, is broken in 1.24: its obj/ glue isn't
// published.)
const jcoBindgen = fileURLToPath(
  new URL(
    './node_modules/@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.js',
    import.meta.url,
  ),
);

export default defineConfig({
  // gh-pages serves under https://playground.actcore.dev/ — root path.
  // If we ever deploy under a sub-path, change to `'/playground/'` etc.
  base: '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  // @actcore/web-runtime runs jco's transpiler in a Web Worker (new Worker(..., {type:
  // 'module'})). That worker code-splits (it dynamic-imports the bindgen core
  // wasm), which Rollup can't emit as the default `iife` worker format — it
  // requires ES modules. The worker is created with type:'module' anyway.
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    fs: {
      // @actcore/web-runtime is a linked dep (file:../web-runtime) outside this
      // project root. Its Web Worker entry (dist/transpile.worker.js) is fetched
      // by the browser at runtime, so the dev server must be allowed to serve
      // from the parent workspace dir. (Production `vite build` bundles the
      // worker, so this only matters for `vite dev`.)
      allow: ['..'],
    },
  },
  resolve: {
    alias: {
      '@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.js':
        jcoBindgen,
    },
  },
  optimizeDeps: {
    // Bypass Vite's pre-bundling for @actcore/web-runtime so we can iterate on its
    // source without `npm install`-rebuilding the dep cache.
    //
    // jco-transpile's vendored bindgen MUST also be excluded: it loads its core
    // wasm via `new URL('./x.core.wasm', import.meta.url)`. esbuild's pre-bundle
    // rewrites that to a `.vite/deps/` sibling but never copies the .wasm there,
    // so the URL 200-falls-back to index.html and `WebAssembly.compile` chokes on
    // the HTML. Excluding it makes Vite serve the bindgen from its real
    // node_modules path, where the sibling .core.wasm files exist. (Dev only —
    // `vite build` bundles + emits these assets correctly.)
    exclude: ['@actcore/web-runtime', '@bytecodealliance/jco-transpile'],
  },
});